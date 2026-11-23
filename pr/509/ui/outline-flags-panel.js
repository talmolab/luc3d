// ui/outline-flags-panel.js — the Outlines panel: how the animal outlines
// (ui/animal-outlines.js) stand per camera, and the flags on bad ones.
//
// Flagging: Shift+O (or the panel's Flag outline… button) opens a small dialog
// for the camera view the pointer was last over, at the frame on screen, with
// the animal under the pointer already chosen; pick the reason, add a note if
// you like, Enter. Flags are per session, saved in the project
// (`metadata.lucid.outlineFlags`, import-export/outline-flags-metadata.js), and
// listed here by frame: a click on a row goes to that frame and view; ✕ removes
// one. Export… writes a ZIP of every flagged camera frame (the frame, its
// outlines now as a label image and a preview) with each camera's empty arena
// and a manifest (import-export/outline-export.js): feedback and training data.
//
// Depends on: ui/app-state.js, ui/animal-outlines.js, ui/frame-readout.js,
//             ui/info-tip.js, ui/plane-definition.js (`ICON_INFO`),
//             ui/loading-overlay.js, pose/outline-flags.js, pose/triangulation.js,
//             import-export/outline-export.js, import-export/save-load.js

import { state, interactionManager, videoController, isViewDocked } from './app-state.js?v=a2771a0eb37d';
import {
    outlinesEnabled, outlineCameraState, ensureBackgrounds, animalsInView, drawnOutlines, outlineAnimalAt,
    computeViewOutlines, paintOutlines, currentOutlineParams, resetOutlines, BACKGROUND_FRAMES, editedEntry, entryLabels,
    scanOutlines, outlineScan, sampleFrames,
} from './animal-outlines.js?v=a2771a0eb37d';
import { formatFrameNumber } from './frame-readout.js?v=a2771a0eb37d';
import { setInfoTip } from './info-tip.js?v=a2771a0eb37d';
import { ICON_INFO } from './plane-definition.js?v=a2771a0eb37d';
import { showLoadingProgress, hideLoading, yieldToPaint } from './loading-overlay.js?v=a2771a0eb37d';
import {
    OUTLINE_FLAG_REASONS, OUTLINE_NOTE_MAX, outlineFlags, addOutlineFlag, removeOutlineFlag, outlineFlagReasonLabel,
} from '../pose/outline-flags.js?v=a2771a0eb37d';
import { getInstanceGroupsForFrame, ensureLazyFrameData } from '../pose/triangulation.js?v=a2771a0eb37d';
import { zipStore, encodePngGray, OUTLINE_EXPORT_README, outlineEntryBase, safeFileName } from '../import-export/outline-export.js?v=a2771a0eb37d';
import { markDirty, setStatus } from '../import-export/save-load.js?v=a2771a0eb37d';
import { outlineEdits, outlineEditAt, revertOutlineEdit, BRUSH_MIN, BRUSH_MAX } from '../pose/outline-edits.js?v=a2771a0eb37d';
import { brushState, setBrushOn, setBrushRadius, setBrushAnimal, onBrushChange } from './outline-brush.js?v=a2771a0eb37d';
import { drawAllOverlays } from './rendering.js?v=a2771a0eb37d';
import { keyframeIndices } from './image-embedder.js?v=a2771a0eb37d';

var OUTLINES_INFO = 'An outline per camera and animal, made the idtracker.ai way: pixels brighter than the camera\'s empty arena, ' +
    'grouped into blobs, each blob given to the animal whose pose is in it (split by nearest skeleton where animals touch), tails traced along their keypoints.';
var BRUSH_INFO = 'Correct an outline by hand: with the brush on, hold the left button over a camera view to draw the animal, the right button to erase. ' +
    'The corrected outline replaces the computed one on that camera frame, is saved with the project and exported as the corrected mask.';
var SUSPECT_INFO = 'Outlines the poses disagree with: two or more of an animal\'s tail keypoints off its outline, body keypoints on another animal\'s outline or on none, ' +
    'or a pose with no outline. Red rings mark those keypoints in the views. Check… goes through frames spread over the video.';
var FLAGS_INFO = 'Hover over a bad outline in a camera view and press Shift+O to flag it. Flags are saved with the project; ' +
    'Export… writes each flagged frame with its outlines for checking or training.';

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function n(x) { return Number(x).toLocaleString('en-US'); }

function viewByName(name) {
    return (state.views || []).find(function (v) { return v.name === name; }) || null;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** (Re)render the Outlines panel for the active session. Cheap. */
export function refreshOutlinePanel() {
    var host = typeof document !== 'undefined' && document.getElementById('outlinePanel');
    if (!host) return;
    var session = state.session;
    var on = outlinesEnabled();
    var views = state.views || [];
    var rows = views.map(function (v) {
        var c = session ? outlineCameraState(session, v.name) : null;
        var status = !v.decoder ? 'no video' : !c ? '—' : c.status === 'building' ? 'building…' :
            c.status === 'failed' ? 'failed: ' + c.error : 'ready';
        var model = c && c.model ? n(Math.round(c.model.median)) + ' ± ' + n(Math.round(c.model.sd)) : (c && c.status === 'ready' ? 'no blob with one animal alone' : '');
        return '<tr><td>' + esc(v.name) + '</td><td>' + esc(status) + '</td><td style="text-align:right;">' +
            (c && c.frames ? n(c.frames.length) : '') + '</td><td style="text-align:right;">' + esc(model) + '</td></tr>';
    }).join('');
    var flags = outlineFlags(session);
    var cur = state.currentFrame;
    host.innerHTML =
        '<details class="info-section info-collapsible" id="outlineStatusSection" open>' +
        '<summary><h3>Animal outlines</h3><button type="button" class="plane-section-info" id="outlineInfo" aria-label="About animal outlines"></button></summary>' +
        '<div class="outline-onoff">' + (on ? 'Shown in the camera views.' : 'Off.') +
        ' <button class="panel-btn" id="outlineToggle">' + (on ? 'Hide' : 'Show outlines') + '</button>' +
        (on ? ' <button class="panel-btn" id="outlineRebuild" title="Sample the videos again for each camera\'s empty arena">Rebuild empty arenas</button>' : '') +
        '</div>' +
        (views.length ? '<table class="data-table outline-cams"><thead><tr><th>Camera</th><th>Empty arena</th>' +
            '<th style="text-align:right;" title="Frames sampled for the empty arena">Frames</th>' +
            '<th style="text-align:right;" title="Single-animal blob area, px: median ± s.d.">One animal, px</th></tr></thead><tbody>' + rows + '</tbody></table>'
            : '<p class="table-empty">No camera views.</p>') +
        '</details>' +
        '<details class="info-section info-collapsible" id="outlineFlagsSection" open>' +
        '<summary><h3>Flagged outlines</h3><button type="button" class="plane-section-info" id="outlineFlagsInfo" aria-label="About outline flags"></button>' +
        '<span class="info-collapsible-count" id="outlineFlagCount">' + n(flags.length) + '</span></summary>' +
        '<div class="outline-flag-tools"><button class="panel-btn" id="outlineFlagBtn" title="Flag the outline in the view under the pointer (Shift+O)">Flag outline…</button>' +
        '<button class="panel-btn" id="outlineExportBtn"' + (flags.length || outlineEdits(session).size ? '' : ' disabled') + ' title="A ZIP of every flagged or corrected camera frame with its outlines">Export…</button></div>' +
        (flags.length ? '<table class="data-table outline-flag-list" id="outlineFlagList"><thead><tr><th style="text-align:right;">Frame</th><th>Camera</th><th>Animal</th><th>Reason</th><th></th></tr></thead><tbody>' +
            flags.map(function (f, i) {
                return '<tr class="outline-flag-row' + (f.frame === cur ? ' is-current' : '') + '" data-i="' + i + '" title="Go to this frame">' +
                    '<td style="text-align:right;">' + formatFrameNumber(f.frame + 1) + '</td><td>' + esc(f.camera) + '</td>' +
                    '<td>' + esc(f.animal || 'several / not sure') + (f.source === '3d' ? ' <span class="outline-src" title="Its pose here was its 3D, projected">3D</span>' : '') + '</td>' +
                    '<td>' + esc(outlineFlagReasonLabel(f.reason)) + (f.note ? '<div class="outline-flag-note">' + esc(f.note) + '</div>' : '') + '</td>' +
                    '<td><button class="outline-flag-del" data-del="' + i + '" title="Remove this flag" aria-label="Remove this flag">✕</button></td></tr>';
            }).join('') + '</tbody></table>'
            : '<p class="table-empty" id="outlineFlagsEmpty">No flags. Hover over a bad outline and press Shift+O.</p>') +
        '</details>' + suspectHtml(session) + brushHtml(session);
    var info = host.querySelector('#outlineInfo');
    if (info) { info.innerHTML = ICON_INFO; setInfoTip(info, OUTLINES_INFO); }
    var finfo = host.querySelector('#outlineFlagsInfo');
    if (finfo) { finfo.innerHTML = ICON_INFO; setInfoTip(finfo, FLAGS_INFO); }
    var t = host.querySelector('#outlineToggle');
    if (t) t.addEventListener('click', function () { setOutlinesShown(!outlinesEnabled()); });
    var rb = host.querySelector('#outlineRebuild');
    if (rb) rb.addEventListener('click', function () {
        if (!state.session) return;
        resetOutlines(state.session);
        refreshOutlinePanel();
        ensureBackgrounds(state.session, shownViews()).then(refreshOutlinePanel, refreshOutlinePanel);
    });
    var fb = host.querySelector('#outlineFlagBtn');
    if (fb) fb.addEventListener('click', function () { openOutlineFlagDialog({ returnFocusTo: fb }); });
    var eb = host.querySelector('#outlineExportBtn');
    if (eb) eb.addEventListener('click', function () { exportOutlineFlags(state.session); });
    wireBrush(host, session);
    wireSuspects(host, session);
    var list = host.querySelector('#outlineFlagList');
    if (list) list.addEventListener('click', function (e) {
        var del = e.target.closest('[data-del]');
        if (del) {
            var f = flags[+del.dataset.del];
            if (f && removeOutlineFlag(session, f)) { markDirty(); refreshOutlinePanel(); setStatus('Removed the flag on ' + f.camera + ', frame ' + formatFrameNumber(f.frame + 1)); }
            return;
        }
        var row = e.target.closest('.outline-flag-row');
        if (row) goToFlag(flags[+row.dataset.i]);
    });
}

// ---------------------------------------------------------------------------
// Suspect outlines (poses that disagree with their outline)
// ---------------------------------------------------------------------------

var SCAN_DEFAULT = 100;
var _scanning = false;

/** Suspects on the frame on screen (every shown camera) and from the last check, deduplicated, by frame. */
export function suspectRows(session) {
    var rows = [], seen = new Set();
    var add = function (r) {
        var k = r.frame + '|' + r.camera + '|' + r.animal + '|' + r.reason;
        if (seen.has(k)) return;
        seen.add(k); rows.push(r);
    };
    if (session) {
        shownViews().forEach(function (v) {
            var d = drawnOutlines(session, v.name);
            if (!d || d.edited || d.frame !== state.currentFrame || !d.suspects) return;
            d.suspects.forEach(function (sus) {
                var a = d.animals[sus.animal] || {};
                add({ frame: d.frame, camera: v.name, animal: a.name || null, identity: a.identity, track: a.track, source: a.source, reason: sus.reason, detail: sus.detail, weight: sus.weight });
            });
        });
        var scan = outlineScan(session);
        if (scan) scan.results.forEach(add);
    }
    rows.sort(function (a, b) { return (a.frame - b.frame) || (a.camera < b.camera ? -1 : a.camera > b.camera ? 1 : 0); });
    return rows;
}

function isFlagged(session, r) {
    return outlineFlags(session).some(function (f) { return f.frame === r.frame && f.camera === r.camera && f.animal === r.animal; });
}

function suspectListHtml(session) {
    var rows = suspectRows(session);
    var scan = outlineScan(session);
    var head = scan ? '<div class="outline-scan-summary">Last check: ' + n(scan.frames) + ' frames, ' + n(scan.results.length) + ' suspect' + (scan.results.length === 1 ? '' : 's') + '.</div>' : '';
    if (!rows.length) return head + '<p class="table-empty" id="outlineSuspectsEmpty">' + (outlinesEnabled() ? 'None on this frame.' : 'Turn the outlines on to check them.') + '</p>';
    return head + '<table class="data-table outline-suspect-list"><thead><tr><th style="text-align:right;">Frame</th><th>Camera</th><th>Why</th><th></th></tr></thead><tbody>' +
        rows.map(function (r, i) {
            return '<tr class="outline-flag-row outline-suspect-row' + (r.frame === state.currentFrame ? ' is-current' : '') + '" data-s="' + i + '" title="Go to this frame">' +
                '<td style="text-align:right;">' + formatFrameNumber(r.frame + 1) + '</td><td>' + esc(r.camera) + '</td>' +
                '<td>' + esc(outlineFlagReasonLabel(r.reason)) + '<div class="outline-flag-note">' + esc(r.detail) + '</div></td>' +
                '<td>' + (isFlagged(session, r) ? '<span class="outline-src">flagged</span>' : '<button class="panel-btn outline-suspect-flag" data-flag="' + i + '">Flag</button>') + '</td></tr>';
        }).join('') + '</tbody></table>';
}

function suspectHtml(session) {
    var rows = suspectRows(session);
    return '<details class="info-section info-collapsible" id="outlineSuspectSection" open>' +
        '<summary><h3>Suspect outlines</h3><button type="button" class="plane-section-info" id="outlineSuspectInfo" aria-label="About suspect outlines"></button>' +
        '<span class="info-collapsible-count" id="outlineSuspectCount">' + n(rows.length) + '</span></summary>' +
        '<div class="outline-flag-tools"><label class="outline-brush-size">Check <input type="number" id="outlineScanN" min="1" max="100000" value="' + SCAN_DEFAULT + '"> frames</label>' +
        '<button class="panel-btn" id="outlineScanBtn"' + (_scanning ? ' disabled' : '') + ' title="Work out the outlines on frames spread over the video and list the ones the poses disagree with">Check…</button>' +
        '<button class="panel-btn" id="outlineFlagAllBtn"' + (rows.some(function (r) { return !isFlagged(session, r); }) ? '' : ' disabled') + ' title="Flag every suspect listed">Flag all</button></div>' +
        '<div id="outlineSuspectList">' + suspectListHtml(session) + '</div></details>';
}

/** Re-render only the suspect list (outlines landed; the frame changed). */
export function refreshSuspectList() {
    var host = typeof document !== 'undefined' && document.getElementById('outlineSuspectList');
    if (!host) return;
    host.innerHTML = suspectListHtml(state.session);
    var cnt = document.getElementById('outlineSuspectCount');
    var rows = suspectRows(state.session);
    if (cnt) cnt.textContent = n(rows.length);
    var all = document.getElementById('outlineFlagAllBtn');
    if (all) all.disabled = !rows.some(function (r) { return !isFlagged(state.session, r); });
}

function flagSuspect(session, r) {
    return addOutlineFlag(session, { frame: r.frame, camera: r.camera, animal: r.animal, identity: r.identity, track: r.track, source: r.source, reason: r.reason, note: r.detail });
}

/** Check `count` frames spread over the video (keyframes when the first camera has enough). -> suspects */
export async function checkOutlineFrames(session, count) {
    if (!session || _scanning) return null;
    var views = shownViews().filter(function (v) { return v.decoder; });
    if (!views.length) { setStatus('No camera video to check outlines in'); return null; }
    if (!outlinesEnabled()) setOutlinesShown(true);
    var total = views[0].decoder.samples ? views[0].decoder.samples.length : state.totalFrames;
    var kf = null;
    try { kf = await keyframeIndices(views[0].decoder); } catch (e) { kf = null; }
    var frames = sampleFrames(total, kf ? Array.from(kf) : null, Math.max(1, Math.min(count | 0, total)));
    _scanning = true;
    var stop = false;
    var onKey = function (e) { if (e.key === 'Escape') { stop = true; e.preventDefault(); e.stopPropagation(); } };
    document.addEventListener('keydown', onKey, true);
    refreshOutlinePanel();
    try {
        showLoadingProgress('Checking outlines', 0, frames.length, { title: 'Suspect outlines', detail: views.length + ' cameras · Esc stops' });
        await yieldToPaint();
        var found = await scanOutlines(session, views, frames, function (d, t) {
            showLoadingProgress('Checking outlines', d, t, { title: 'Suspect outlines', detail: views.length + ' cameras · Esc stops' });
        }, function () { return stop; });
        setStatus('Checked ' + n(frames.length) + ' frames' + (stop ? ' (stopped)' : '') + ': ' + n(found.length) + ' suspect outline' + (found.length === 1 ? '' : 's'));
        return found;
    } finally {
        document.removeEventListener('keydown', onKey, true);
        _scanning = false;
        hideLoading();
        refreshOutlinePanel();
        if (state.session) drawAllOverlays(state.currentFrame);
    }
}

function wireSuspects(host, session) {
    var info = host.querySelector('#outlineSuspectInfo');
    if (info) { info.innerHTML = ICON_INFO; setInfoTip(info, SUSPECT_INFO); }
    var btn = host.querySelector('#outlineScanBtn');
    if (btn) btn.addEventListener('click', function () {
        var nIn = host.querySelector('#outlineScanN');
        checkOutlineFrames(session, nIn ? +nIn.value || SCAN_DEFAULT : SCAN_DEFAULT);
    });
    var all = host.querySelector('#outlineFlagAllBtn');
    if (all) all.addEventListener('click', function () {
        var k = 0;
        suspectRows(session).forEach(function (r) { if (!isFlagged(session, r) && flagSuspect(session, r)) k++; });
        if (k) { markDirty(); setStatus('Flagged ' + n(k) + ' suspect outline' + (k === 1 ? '' : 's')); }
        refreshOutlinePanel();
    });
    var list = host.querySelector('#outlineSuspectList');
    if (list) list.addEventListener('click', function (e) {
        var rows = suspectRows(session);
        var fb = e.target.closest('[data-flag]');
        if (fb) {
            var r = rows[+fb.dataset.flag];
            if (r && flagSuspect(session, r)) { markDirty(); setStatus('Flagged ' + r.camera + ', frame ' + formatFrameNumber(r.frame + 1) + ': ' + r.detail); }
            refreshOutlinePanel();
            return;
        }
        var row = e.target.closest('.outline-suspect-row');
        if (row) goToFlag(rows[+row.dataset.s]);
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('lucid:outlines-landed', function () { refreshSuspectList(); });
}

// ---------------------------------------------------------------------------
// Correct outlines (the brush)
// ---------------------------------------------------------------------------

function brushCamera() {
    var cam = interactionManager && interactionManager.lastInteractedView;
    var views = shownViews();
    if (!cam || !viewByName(cam)) cam = views.length ? views[0].name : null;
    return cam;
}

function brushHtml(session) {
    var b = brushState();
    var cam = brushCamera();
    var frame = state.currentFrame;
    var edit = cam && session ? outlineEditAt(session, frame, cam) : null;
    var drawn = cam && session ? drawnOutlines(session, cam) : null;
    var animals = edit ? edit.animals : (drawn && drawn.frame === frame ? drawn.animals : []);
    var edits = Array.from(outlineEdits(session).values()).sort(function (x, y) { return (x.frame - y.frame) || (x.camera < y.camera ? -1 : 1); });
    return '<details class="info-section info-collapsible" id="outlineBrushSection" open>' +
        '<summary><h3>Correct outlines</h3><button type="button" class="plane-section-info" id="outlineBrushInfo" aria-label="About correcting outlines"></button>' +
        '<span class="info-collapsible-count" id="outlineEditCount">' + n(edits.length) + '</span></summary>' +
        '<div class="outline-brush-tools"><button class="panel-btn' + (b.on ? ' active' : '') + '" id="outlineBrushBtn" title="Brush on/off (B)">' + (b.on ? 'Brush on' : 'Brush') + '</button>' +
        '<label class="outline-brush-size">Size <input type="range" id="outlineBrushSize" min="' + BRUSH_MIN + '" max="' + BRUSH_MAX + '" value="' + b.radius + '">' +
        '<span id="outlineBrushSizeVal">' + b.radius + ' px</span></label></div>' +
        '<p class="outline-brush-help">Hold the left button to draw, the right to erase. A stroke that starts on an animal draws that animal; ' +
        '[ and ] change the size; ' + (/Mac/.test(navigator.platform || '') ? '⌘Z' : 'Ctrl+Z') + ' undoes a stroke; Esc puts the brush away.</p>' +
        (animals.length ? '<div class="outline-brush-animals" id="outlineBrushAnimals"><span>Off an animal, draw:</span>' +
            animals.map(function (a, i) {
                return '<label class="outline-flag-choice"><input type="radio" name="outlineBrushAnimal" value="' + i + '"' + (b.animal === i ? ' checked' : '') + '>' +
                    '<span class="outline-swatch" style="background:' + esc(a.color) + '"></span>' + esc(a.name) + '</label>';
            }).join('') + '</div>' : '') +
        (edits.length ? '<table class="data-table outline-edit-list" id="outlineEditList"><thead><tr><th style="text-align:right;">Frame</th><th>Camera</th><th>Animals</th><th></th></tr></thead><tbody>' +
            edits.map(function (e, i) {
                return '<tr class="outline-flag-row outline-edit-row' + (e.frame === frame ? ' is-current' : '') + '" data-e="' + i + '" title="Go to this frame">' +
                    '<td style="text-align:right;">' + formatFrameNumber(e.frame + 1) + '</td><td>' + esc(e.camera) + '</td>' +
                    '<td>' + e.animals.map(function (a) { return esc(a.name || '?'); }).join(', ') + '</td>' +
                    '<td><button class="outline-flag-del" data-revert="' + i + '" title="Throw this correction away" aria-label="Throw this correction away">✕</button></td></tr>';
            }).join('') + '</tbody></table>'
            : '<p class="table-empty" id="outlineEditsEmpty">No corrected outlines.</p>') +
        '</details>';
}

function wireBrush(host, session) {
    var info = host.querySelector('#outlineBrushInfo');
    if (info) { info.innerHTML = ICON_INFO; setInfoTip(info, BRUSH_INFO); }
    var btn = host.querySelector('#outlineBrushBtn');
    if (btn) btn.addEventListener('click', function () { setBrushOn(!brushState().on); });
    var size = host.querySelector('#outlineBrushSize');
    if (size) size.addEventListener('input', function () { setBrushRadius(+size.value); });
    var pick = host.querySelector('#outlineBrushAnimals');
    if (pick) pick.addEventListener('change', function (e) { if (e.target.name === 'outlineBrushAnimal') setBrushAnimal(+e.target.value); });
    var list = host.querySelector('#outlineEditList');
    var edits = Array.from(outlineEdits(session).values()).sort(function (x, y) { return (x.frame - y.frame) || (x.camera < y.camera ? -1 : 1); });
    if (list) list.addEventListener('click', function (e) {
        var rv = e.target.closest('[data-revert]');
        if (rv) {
            var ed = edits[+rv.dataset.revert];
            if (ed && revertOutlineEdit(session, ed.frame, ed.camera)) {
                markDirty();
                refreshOutlinePanel();
                drawAllOverlaysSoon();
                setStatus('Threw away the correction of ' + ed.camera + ', frame ' + formatFrameNumber(ed.frame + 1));
            }
            return;
        }
        var row = e.target.closest('.outline-edit-row');
        if (row) { var x = edits[+row.dataset.e]; if (x) goToFlag({ frame: x.frame, camera: x.camera }); }
    });
}

function drawAllOverlaysSoon() {
    if (state.session) drawAllOverlays(state.currentFrame);
}

if (typeof window !== 'undefined') {
    onBrushChange(function (what) {
        if (what === 'radius') {
            var v = document.getElementById('outlineBrushSizeVal'), r = document.getElementById('outlineBrushSize');
            var b = brushState();
            if (v) v.textContent = b.radius + ' px';
            if (r && +r.value !== b.radius && document.activeElement !== r) r.value = b.radius;
            return;
        }
        refreshOutlinePanel();
    });
}

function shownViews() {
    var docked = (state.views || []).filter(isViewDocked);
    return docked.length ? docked : (state.views || []);
}

/** Turn the overlay on or off (Visibility ▸ Animal Outlines ▸ Show, which persists it). */
export function setOutlinesShown(on) {
    var cb = document.getElementById('visOutlines');
    if (!cb) return;
    if (cb.checked !== !!on) {
        cb.checked = !!on;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refreshOutlinePanel();
}

/** Go to a flag's frame, with its camera as the active view. */
export function goToFlag(f) {
    if (!f) return;
    if (interactionManager) interactionManager.lastInteractedView = f.camera;
    var p = videoController ? Promise.resolve(videoController.seekToFrame(f.frame)) : Promise.resolve();
    p.then(function () {
        refreshOutlinePanel();
        var view = viewByName(f.camera);
        var el = view && view.overlayCanvas && view.overlayCanvas.closest ? view.overlayCanvas.closest('.video-container, .view-container, .canvas-wrapper') : null;
        if (el && el.animate) el.animate([{ outline: '3px solid #f5a623' }, { outline: '3px solid transparent' }], { duration: 900 });
    });
}

// ---------------------------------------------------------------------------
// The flag dialog
// ---------------------------------------------------------------------------

function animalsForDialog(session, cam, frame) {
    var drawn = drawnOutlines(session, cam);
    if (drawn && drawn.frame === frame) return drawn.animals;
    return animalsInView(session, frame, cam, getInstanceGroupsForFrame(frame), session.getFrameGroup ? session.getFrameGroup(frame) : null);
}

var _dialogOpen = false;

/** Whether the flag dialog is open (keyboard shortcuts stay out of its way). */
export function isOutlineFlagDialogOpen() { return _dialogOpen; }

/**
 * Open the flag dialog. `opts.camera`: the view (default: the one the pointer
 * was last over, else the first shown); `opts.animal`: the animal's index in
 * that view's outline (default: the one under the pointer).
 */
export function openOutlineFlagDialog(opts) {
    opts = opts || {};
    var session = state.session;
    if (!session || _dialogOpen) return null;
    var views = shownViews();
    if (!views.length) { setStatus('No camera view to flag an outline in'); return null; }
    var cam = opts.camera || (interactionManager && interactionManager.lastInteractedView) || views[0].name;
    if (!viewByName(cam)) cam = views[0].name;
    var frame = state.currentFrame;
    var pre = opts.animal;
    if (pre == null && interactionManager && interactionManager.lastCursorPos && interactionManager.lastInteractedView === cam) {
        var hit = outlineAnimalAt(session, cam, interactionManager.lastCursorPos[0], interactionManager.lastCursorPos[1]);
        if (hit) pre = hit.index;
    }
    _dialogOpen = true;
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay outline-flag-overlay';
    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal outline-flag-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Flag a bad outline');
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    var reason = opts.reason || null;
    var animals = [];
    function animalHtml() {
        animals = animalsForDialog(session, cam, frame);
        var items = animals.map(function (a, i) {
            return '<label class="outline-flag-choice"><input type="radio" name="outlineFlagAnimal" value="' + i + '"' + (i === pre ? ' checked' : '') + '>' +
                '<span class="outline-swatch" style="background:' + esc(a.color) + '"></span>' + esc(a.name) +
                (a.source === '3d' ? ' <span class="outline-src" title="No detection in this camera: its 3D, projected">3D</span>' : '') + '</label>';
        });
        items.push('<label class="outline-flag-choice"><input type="radio" name="outlineFlagAnimal" value="-1"' + (pre == null || pre < 0 || pre >= animals.length ? ' checked' : '') + '>Several / not sure</label>');
        return items.join('');
    }
    modal.innerHTML =
        '<h3>Flag a bad outline</h3>' +
        '<div class="outline-flag-where">Frame <b>' + formatFrameNumber(frame + 1) + '</b> in ' +
        '<select id="outlineFlagCamera">' + views.map(function (v) { return '<option' + (v.name === cam ? ' selected' : '') + '>' + esc(v.name) + '</option>'; }).join('') + '</select></div>' +
        '<div class="outline-flag-label">Animal</div><div class="outline-flag-animals" id="outlineFlagAnimals">' + animalHtml() + '</div>' +
        '<div class="outline-flag-label">What is wrong</div><div class="outline-flag-reasons">' +
        OUTLINE_FLAG_REASONS.map(function (r) {
            return '<label class="outline-flag-choice"><input type="radio" name="outlineFlagReason" value="' + r.id + '"' + (r.id === reason ? ' checked' : '') + '>' + esc(r.label) + '</label>';
        }).join('') + '</div>' +
        '<input type="text" id="outlineFlagNote" class="outline-flag-note-input" maxlength="' + OUTLINE_NOTE_MAX + '" placeholder="Note (optional)">' +
        '<div class="modal-actions"><button id="outlineFlagCancel">Cancel</button>' +
        '<button class="primary" id="outlineFlagOk" disabled>Flag</button></div>';
    var ok = modal.querySelector('#outlineFlagOk');
    function sync() { ok.disabled = !modal.querySelector('input[name="outlineFlagReason"]:checked'); }
    modal.addEventListener('change', function (e) {
        if (e.target.id === 'outlineFlagCamera') {
            cam = e.target.value; pre = null;
            modal.querySelector('#outlineFlagAnimals').innerHTML = animalHtml();
        }
        sync();
    });
    function close() {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        _dialogOpen = false;
        if (opts.returnFocusTo && opts.returnFocusTo.focus) { try { opts.returnFocusTo.focus(); } catch (e) { /* gone */ } }
    }
    function submit() {
        var r = modal.querySelector('input[name="outlineFlagReason"]:checked');
        if (!r) return;
        var ai = +(modal.querySelector('input[name="outlineFlagAnimal"]:checked') || { value: -1 }).value;
        var a = ai >= 0 ? animals[ai] : null;
        var f = addOutlineFlag(session, {
            frame: frame, camera: cam, animal: a ? a.name : null, identity: a ? a.identity : null, track: a ? a.track : null,
            source: a ? a.source : null, reason: r.value, note: modal.querySelector('#outlineFlagNote').value.trim(),
        });
        close();
        if (!f) return;
        markDirty();
        refreshOutlinePanel();
        setStatus('Flagged ' + (f.animal ? f.animal + '’s outline' : 'the outlines') + ' in ' + f.camera + ', frame ' + formatFrameNumber(f.frame + 1) + ': ' + outlineFlagReasonLabel(f.reason));
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
        if (e.key === 'Enter') {
            // Enter on a focused button is that button (Cancel stays Cancel)
            if (e.target && e.target.tagName === 'BUTTON') return;
            e.preventDefault(); e.stopPropagation();
            submit();
            return;
        }
        // keep the app's shortcuts out while the dialog is up
        e.stopPropagation();
    }
    document.addEventListener('keydown', onKey, true);
    modal.querySelector('#outlineFlagCancel').addEventListener('click', close);
    ok.addEventListener('click', submit);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    sync();
    var first = modal.querySelector('input[name="outlineFlagReason"]');
    if (first) first.focus();
    return modal;
}

/** Shift+O: flag the outline under the pointer (the dialog, pre-filled). */
export function flagOutlineUnderPointer() {
    return openOutlineFlagDialog({});
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function stamp(d) {
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function canvasBlobBytes(canvas, type, quality) {
    var blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: type, quality: quality })
        : await new Promise(function (res) { canvas.toBlob(res, type, quality); });
    return new Uint8Array(await blob.arrayBuffer());
}

function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/**
 * Build the export of `session`'s flags: -> {bytes (the ZIP), manifest,
 * missing: number of camera frames without outlines}. `onStep(done, total)`.
 */
export async function buildOutlineFlagsExport(session, onStep) {
    var flags = outlineFlags(session).slice();
    var byFrame = new Map();
    flags.forEach(function (f) {
        var k = f.frame + '\u0000' + f.camera;
        if (!byFrame.has(k)) byFrame.set(k, { frame: f.frame, camera: f.camera, flags: [] });
        byFrame.get(k).flags.push(f);
    });
    // corrected outlines go too, flagged or not
    outlineEdits(session).forEach(function (e) {
        var k = e.frame + '\u0000' + e.camera;
        if (!byFrame.has(k)) byFrame.set(k, { frame: e.frame, camera: e.camera, flags: [] });
    });
    var entries = [{ name: 'README.txt', data: OUTLINE_EXPORT_README }];
    var manifest = {
        format: 'lucid-outline-flags', version: 1, exported_at: new Date().toISOString(),
        session: session.name || null, params: currentOutlineParams(), background_frames: BACKGROUND_FRAMES,
        cameras: {}, entries: [],
    };
    var cams = new Set();
    var items = Array.from(byFrame.values()).sort(function (a, b) { return (a.frame - b.frame) || (a.camera < b.camera ? -1 : a.camera > b.camera ? 1 : 0); });
    var missing = 0;
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (onStep) onStep(i, items.length);
        var view = viewByName(it.camera);
        var rec = { frame: it.frame, camera: it.camera, flags: it.flags, files: null, animals: [], blobs: [] };
        manifest.entries.push(rec);
        if (!view || !view.decoder) { rec.missing = 'no video for this camera'; missing++; continue; }
        if (session.lazyLoader) await ensureLazyFrameData(it.frame);
        var animals = animalsInView(session, it.frame, it.camera, session.instanceGroups.get(it.frame) || [],
            session.getFrameGroup ? session.getFrameGroup(it.frame) : null);
        var auto = null;
        try { auto = await computeViewOutlines(session, view, it.frame, animals); } catch (e) { rec.missing = String(e && e.message || e); }
        var edited = editedEntry(session, it.frame, it.camera);
        var entry = edited || auto;
        if (!entry) { rec.missing = rec.missing || 'no outlines (no empty arena or frame)'; missing++; continue; }
        delete rec.missing;
        cams.add(it.camera);
        var base = outlineEntryBase(it.frame, it.camera);
        var w = entry.w, h = entry.h;
        var bm = await view.decoder.peekFrame(it.frame, w);
        var files = { labels: 'labels/' + base + '.png' };
        entries.push({ name: files.labels, data: await encodePngGray(entryLabels(entry), w, h) });
        rec.edited = !!edited;
        if (edited && auto && entryLabels(auto)) {
            // the computed outline beside the corrected one; its own animal numbering
            files.labels_auto = 'labels_auto/' + base + '.png';
            entries.push({ name: files.labels_auto, data: await encodePngGray(entryLabels(auto), auto.w, auto.h) });
            rec.animals_auto = auto.animals.map(function (a, k) { return { label: k + 1, name: a.name, identity: a.identity, track: a.track, source: a.source }; });
        }
        if (bm) {
            var cv = makeCanvas(w, h), ctx = cv.getContext('2d');
            ctx.drawImage(bm, 0, 0, w, h);
            if (bm.close) bm.close();
            files.frame = 'frames/' + base + '.png';
            entries.push({ name: files.frame, data: await canvasBlobBytes(cv, 'image/png') });
            paintOutlines(ctx, entry, { videoWidth: w, videoHeight: h, fillAlpha: 0.3, over: true });
            files.preview = 'previews/' + base + '.jpg';
            entries.push({ name: files.preview, data: await canvasBlobBytes(cv, 'image/jpeg', 0.9) });
        }
        rec.files = files;
        rec.size = [w, h];
        rec.animals = entry.animals.map(function (a, k) {
            var s = (entry.result.animals && entry.result.animals[k]) || {};
            return { label: k + 1, name: a.name, identity: a.identity, track: a.track, source: a.source, color: a.color,
                area: s.area, blobs: s.blobs, tail_px: s.tail, reattached_px: s.reattached };
        });
        rec.blobs = entry.result.blobs.map(function (b) { return { area: b.area, kind: b.kind, animals: b.animals.map(function (k) { return k + 1; }) }; });
        await yieldToPaint();
    }
    for (var cam of cams) {
        var c = outlineCameraState(session, cam);
        if (!c || !c.bg) continue;
        var bgName = 'backgrounds/' + safeFileName(cam) + '.png';
        entries.push({ name: bgName, data: await encodePngGray(c.bg, c.w, c.h) });
        manifest.cameras[cam] = { size: [c.w, c.h], background: bgName, sampled_frames: c.frames, animals: c.nAnimals, area_model: c.model };
    }
    entries.splice(1, 0, { name: 'manifest.json', data: JSON.stringify(manifest, null, 1) });
    if (onStep) onStep(items.length, items.length);
    return { bytes: zipStore(entries), manifest: manifest, missing: missing };
}

/** Outlines ▸ Export…: the ZIP, downloaded. */
export async function exportOutlineFlags(session) {
    if (!session || (!outlineFlags(session).length && !outlineEdits(session).size)) { setStatus('No flagged or corrected outlines to export'); return null; }
    try {
        showLoadingProgress('Flagged frames', 0, 1, { title: 'Export flagged outlines', unit: 'camera frames' });
        await yieldToPaint();
        var out = await buildOutlineFlagsExport(session, function (d, t) {
            showLoadingProgress('Flagged frames', d, t, { title: 'Export flagged outlines', unit: 'camera frames' });
        });
        var name = 'outline-flags_' + safeFileName(session.name || 'session') + '_' + stamp(new Date()) + '.zip';
        var blob = new Blob([out.bytes], { type: 'application/zip' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        var k = out.manifest.entries.length;
        setStatus('Exported ' + n(k) + ' flagged camera frame' + (k === 1 ? '' : 's') + ' to ' + name +
            (out.missing ? ' (' + n(out.missing) + ' without outlines: see manifest.json)' : ''));
        return out;
    } catch (e) {
        setStatus('Export failed: ' + (e && e.message || e), 'error');
        return null;
    } finally {
        hideLoading();
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('lucid:outlines-changed', function () { refreshOutlinePanel(); });
}
