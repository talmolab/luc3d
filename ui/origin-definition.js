// ui/origin-definition.js — "Set Origin Mode", the last step of the pipeline.
//
// Everything upstream (View ▸ Define Planes: nodes, planes, placements,
// triangulation, plane fit, 3D corner dragging) exists to produce a fitted
// plane. This module turns one corner of one fitted plane plus a choice of
// which way +Z points into the **translation + rotation** that re-express the
// calibration's world frame in the user's frame — the thing this branch is for.
// The math itself is in `pose/origin-frame.js`; this file is the wizard.
//
// A three-step wizard, because the two inputs are picked in the 3D scene and
// each one has to be committed before the next is meaningful:
//
//   'node'    click a corner of a FITTED plane            -> the new origin
//   'axis'    click the red (+n) or blue (-n) arrow       -> the new +Z
//   'confirm' Cancel (back to 'node') / Continue (apply)
//
// Only fitted planes offer corners. An un-fit plane has no normal, so it has no
// +Z to offer and picking it would dead-end the wizard — the restriction is
// enforced in the viewport (`userData.planeFitted`), not just hinted at here.
//
// WHILE THE MODE IS ACTIVE EVERY OTHER BUTTON IS DISABLED. `lockUI` walks the
// menu bar, toolbar and info panel, records each button's prior `disabled`
// state and restores it exactly on exit — so a button that was already disabled
// for its own reasons (Triangulate with nothing selected) does not come back
// enabled. Esc, the mode's Exit button and the wizard's own Cancel/Continue are
// the exceptions, and they are the only way out.
//
// APPLYING AN ORIGIN DOES NOT MOVE ANY DATA. `viewport3d.setOriginFrame` moves
// the displayed grid + axes onto the new frame — and with them the ORBIT, so
// dragging and zooming re-center on the new origin rather than swinging the
// scene about a calibration origin that is no longer drawn; cameras, skeletons
// and planes stay in calibration world coordinates. Re-baking them would silently change
// every 3D number the rest of the app reads and reports, and the transform —
// not a rewritten point cloud — is the deliverable.
//
// The frame IS persisted (`import-export/plane-metadata.js` writes it as the
// origin + the chosen +Z; `pose/origin-frame.js` rebuilds the rest
// deterministically on load), so applying or clearing one marks the project
// dirty. Entering and leaving the mode does not — a wizard the user backed out
// of changed nothing.

import { state, viewport3d } from './app-state.js';
import { setStatus, markDirty } from '../import-export/save-load.js';
import { buildOriginFrame, rebaseExtrinsics } from '../pose/origin-frame.js';
import { getPoint3d, hasPoint3d, Camera } from '../pose/pose-data.js';
import { exportCalibrationTOML, downloadTOML } from '../import-export/file-io.js';
// Circular by design (plane-definition imports this module's `enterOriginMode`
// for its button). Safe: every use is inside a function body, so the binding
// resolves at call time.
import {
    planeState, planeModel, getPlane, planePoints3d, planeNodeNameAt, syncPlanes3D,
    showPlaneDialog,
} from './plane-definition.js';
// Circular for the same reason and under the same rule: this module owns the
// button, that one owns what the button does.
import { showSetCalibrationModal } from './origin-rebase.js';

export const originState = {
    /** @type {boolean} True while Set Origin Mode is active. */
    active: false,
    /** @type {'node'|'axis'|'confirm'} Wizard step; meaningless when inactive. */
    step: 'node',
    /** @type {number|null} Plane the picked corner belongs to. */
    planeId: null,
    /** @type {number|null} Node index of the picked corner. */
    nodeIdx: null,
    /** @type {number[]|null} The picked corner, in old-world coordinates. */
    originPoint: null,
    /** @type {number[]|null} The fitted plane's normal at pick time. */
    normal: null,
    /** @type {number} Candidate-arrow length, scaled to the plane's extent. */
    arrowLength: 0,
    /** @type {'positive'|'negative'|null} Which arrow is chosen. */
    chosen: null,
    /**
     * @type {Object|null} The APPLIED frame from `buildOriginFrame`, or null
     * while the calibration's own frame is in force. Survives leaving the mode
     * — that is the point of the whole exercise.
     */
    frame: null,
};

const STEP_TEXT = {
    node: 'Click a corner of a fitted plane in the 3D view. That corner becomes the new origin.',
    axis: 'Click the red or the blue arrow to choose which way +Z points.',
    confirm: 'Continue re-bases the 3D frame on this origin, or Cancel to pick again.',
};

/** Buttons the mode keeps live; everything else is disabled while it runs. */
const UNLOCKED_IDS = ['originModeExit', 'btnOriginCancel', 'btnOriginContinue'];

/** @type {Array<{el:HTMLElement, was:boolean}>|null} */
var lockedButtons = null;

// ============================================
// Mode enter / exit
// ============================================

export function isOriginModeActive() {
    return originState.active;
}

/**
 * Every plane that has been fit — the only ones offering a corner.
 *
 * A plane's 3D lives on the shared node pool now, so "has 3D" is asked of the
 * materialized points rather than of a field on the plane: a plane whose nodes
 * were all invalidated still holds its `planeFit` until something clears it,
 * and offering its corners would dead-end the wizard on a point that no longer
 * exists.
 */
export function fittedPlanes() {
    return planeModel().planes.filter(function (plane) {
        if (!plane.planeFit) return false;
        var pts = planePoints3d(plane);
        for (var k = 0; k < plane.nodeIds.length; k++) {
            if (hasPoint3d(pts, k)) return true;
        }
        return false;
    });
}

export function enterOriginMode() {
    if (originState.active) return;
    // Refuse rather than open a wizard whose first step can never be completed.
    if (fittedPlanes().length === 0) {
        setStatus('Fit a plane first — Set Origin needs a fitted plane to pick a corner from', 'warning');
        return;
    }

    originState.active = true;
    resetPicks();

    var planeBar = document.getElementById('planeModeBar');
    if (planeBar) planeBar.style.display = 'none';
    var bar = document.getElementById('originModeBar');
    if (bar) bar.style.display = '';

    lockUI(true);
    document.addEventListener('keydown', onOriginKeyDown, true);

    // Dragging off, picking on: `syncPlanes3D` reads `originState.active` for
    // the payload's `editable`, so a corner cannot be dragged out from under
    // the click that is about to select it.
    syncPlanes3D();
    renderWizard();
    setStatus('Set Origin Mode — ' + STEP_TEXT.node);
}

export function exitOriginMode() {
    if (!originState.active) return;
    originState.active = false;

    var bar = document.getElementById('originModeBar');
    if (bar) bar.style.display = 'none';
    var planeBar = document.getElementById('planeModeBar');
    if (planeBar && planeState.active) planeBar.style.display = '';

    document.removeEventListener('keydown', onOriginKeyDown, true);
    lockUI(false);

    if (viewport3d) {
        viewport3d.setOriginPickMode(null);
        viewport3d.clearOriginCandidates();
    }
    resetPicks();
    syncPlanes3D();
    renderWizard();
    renderOriginResult();
}

/** Esc leaves the mode from any step. */
function onOriginKeyDown(e) {
    if (!originState.active) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    exitOriginMode();
    setStatus('Left Set Origin Mode');
}

function resetPicks() {
    originState.step = 'node';
    originState.planeId = null;
    originState.nodeIdx = null;
    originState.originPoint = null;
    originState.normal = null;
    originState.arrowLength = 0;
    originState.chosen = null;
}

// ============================================
// Locking the rest of the UI
// ============================================

/**
 * Disable (or restore) every button outside the wizard.
 *
 * Records the PRIOR state per button rather than blanket-enabling on exit —
 * several of these are disabled for their own reasons (the plane action row
 * with nothing selected), and coming back enabled would misreport what is
 * clickable.
 */
function lockUI(on) {
    if (on) {
        if (lockedButtons) return;
        lockedButtons = [];
        var buttons = document.querySelectorAll(
            '.menu-bar button, .toolbar button, .info-panel button, .plane-panel button, ' +
            '.viewport3d-container button, .timeline-controls button, .plane-mode-bar button');
        for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            if (UNLOCKED_IDS.indexOf(b.id) >= 0) continue;
            lockedButtons.push({ el: b, was: b.disabled });
            b.disabled = true;
        }
        // The menu bar's dropdowns are divs, not buttons, so `disabled` cannot
        // reach them — a class on <body> blocks them in CSS instead.
        document.body.classList.add('origin-mode-lock');
    } else {
        if (lockedButtons) {
            for (var j = 0; j < lockedButtons.length; j++) {
                lockedButtons[j].el.disabled = lockedButtons[j].was;
            }
            lockedButtons = null;
        }
        document.body.classList.remove('origin-mode-lock');
    }
}

// ============================================
// Dragging the instruction overlay
// ============================================
//
// The box sits over the 3D view and can cover the very corner or arrow the
// wizard is asking the user to click, so it can be dragged aside. Only the grip
// takes pointer events — the box keeps `pointer-events: none`, so moving it
// never costs a pick anywhere else.
//
// The position is remembered for the page session (not persisted), in
// container-relative pixels, and re-clamped every time the box is shown: the 3D
// viewport is resizable via its split handles, so a spot that was inside it can
// stop being so while the box is hidden.

/** @type {{x:number, y:number}|null} Where the user dragged the box, or null. */
var boxPos = null;
/** @type {{dx:number, dy:number}|null} Grab point inside the box, while dragging. */
var dragGrab = null;

/** The positioned ancestor the box's `left`/`top` are measured against. */
function boxHost(box) {
    return box.offsetParent || box.parentElement;
}

/** Place the box at container-relative (x, y), clamped to stay fully visible. */
function placeBox(x, y) {
    var box = document.getElementById('originInstruction');
    var host = box && boxHost(box);
    if (!box || !host) return;
    var maxX = Math.max(0, host.clientWidth - box.offsetWidth);
    var maxY = Math.max(0, host.clientHeight - box.offsetHeight);
    boxPos = {
        x: Math.min(Math.max(0, x), maxX),
        y: Math.min(Math.max(0, y), maxY),
    };
    box.style.left = boxPos.x + 'px';
    box.style.top = boxPos.y + 'px';
    // The stylesheet centres the box with `translateX(-50%)`; once it is placed
    // explicitly that offset would put the cursor half a box away from the grip.
    box.style.transform = 'none';
}

/** Re-assert a dragged position (no-op until the user has actually dragged). */
function applyBoxPosition() {
    if (boxPos) placeBox(boxPos.x, boxPos.y);
}

function setupInstructionDrag() {
    var box = document.getElementById('originInstruction');
    var grip = document.getElementById('originDragHandle');
    if (!box || !grip) return;

    grip.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        var host = boxHost(box);
        if (!host) return;
        var boxRect = box.getBoundingClientRect();
        var hostRect = host.getBoundingClientRect();
        dragGrab = { dx: e.clientX - boxRect.left, dy: e.clientY - boxRect.top };
        // Freeze the current (possibly still stylesheet-centred) spot as an
        // explicit left/top before the first move, so the box cannot jump.
        placeBox(boxRect.left - hostRect.left, boxRect.top - hostRect.top);
        if (grip.setPointerCapture) grip.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    });

    grip.addEventListener('pointermove', function (e) {
        if (!dragGrab) return;
        var host = boxHost(box);
        if (!host) return;
        var hostRect = host.getBoundingClientRect();
        placeBox(e.clientX - hostRect.left - dragGrab.dx,
                 e.clientY - hostRect.top - dragGrab.dy);
        e.preventDefault();
    });

    function endDrag(e) {
        if (!dragGrab) return;
        dragGrab = null;
        if (grip.releasePointerCapture && grip.hasPointerCapture &&
            grip.hasPointerCapture(e.pointerId)) {
            grip.releasePointerCapture(e.pointerId);
        }
    }
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);
    // The canvas below reads clicks as picks; a drag that ends over it must not
    // register as one.
    grip.addEventListener('click', function (e) { e.stopPropagation(); });
}

// ============================================
// Wizard rendering + step transitions
// ============================================

/** Push the current step into the 3D overlay and arm the right picker. */
export function renderWizard() {
    var box = document.getElementById('originInstruction');
    var text = document.getElementById('originStepText');
    var legend = document.getElementById('originLegend');
    var confirmRow = document.getElementById('originConfirmRow');
    var hint = document.getElementById('originModeHint');

    if (!originState.active) {
        if (box) box.style.display = 'none';
        return;
    }
    if (box) {
        box.style.display = '';
        // Re-apply (and re-clamp) any position the user dragged it to — the
        // viewport may have been resized while the box was hidden.
        applyBoxPosition();
    }
    if (text) text.textContent = STEP_TEXT[originState.step] || '';
    if (hint) hint.textContent = STEP_TEXT[originState.step] || '';
    if (legend) legend.style.display = (originState.step === 'node') ? 'none' : '';
    if (confirmRow) confirmRow.style.display = (originState.step === 'confirm') ? '' : 'none';

    if (!viewport3d) return;
    if (originState.step === 'node') {
        viewport3d.setOriginPickMode('node');
        viewport3d.clearOriginCandidates();
    } else {
        // 'confirm' keeps the axis picker armed so the user can switch arrows
        // without cancelling — the choice is binary and trivially reversible.
        viewport3d.setOriginPickMode('axis');
        viewport3d.setOriginCandidates({
            origin: originState.originPoint,
            normal: originState.normal,
            length: originState.arrowLength,
            chosen: originState.chosen,
        });
    }
}

/**
 * Arrow length for the +Z candidates: 70% of the plane's own reach from the
 * picked corner.
 *
 * Scaled to the PLANE, not to the camera baseline — a fixed length is invisible
 * on a room-sized plane and shoots off screen on a small one. Returns 0 (the
 * viewport's fallback) if the plane has no other usable corner to measure with.
 */
function arrowLengthFor(plane, points3d, origin) {
    var far = 0;
    for (var k = 0; k < plane.nodeIds.length; k++) {
        if (!hasPoint3d(points3d, k)) continue;
        var p = getPoint3d(points3d, k);
        var d = Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
        if (d > far) far = d;
    }
    return far > 0 ? far * 0.7 : 0;
}

/**
 * Step 1 result: a corner of a fitted plane.
 *
 * `nodeIdx` is an index into the PLANE's own node order — the same order the 3D
 * payload was laid out in, which is what the viewport picked from — not a pool
 * index. The two differ as soon as a node is shared or the pool is reordered.
 */
export function pickOriginNode(planeId, nodeIdx) {
    if (!originState.active || originState.step !== 'node') return false;
    var plane = getPlane(planeId);
    if (!plane || !plane.planeFit) return false;
    var points3d = planePoints3d(plane);
    if (!hasPoint3d(points3d, nodeIdx)) return false;

    var p = getPoint3d(points3d, nodeIdx);
    originState.planeId = planeId;
    originState.nodeIdx = nodeIdx;
    originState.originPoint = [p[0], p[1], p[2]];
    originState.normal = plane.planeFit.normal.slice();
    originState.arrowLength = arrowLengthFor(plane, points3d, originState.originPoint);
    originState.chosen = null;
    originState.step = 'axis';
    renderWizard();
    setStatus('Origin corner: "' + planeNodeNameAt(plane, nodeIdx) +
        '" on plane "' + plane.name + '" — ' + STEP_TEXT.axis);
    return true;
}

/** Step 2 result: which of the two candidate directions is +Z. */
export function pickOriginAxis(which) {
    if (!originState.active) return false;
    if (originState.step !== 'axis' && originState.step !== 'confirm') return false;
    if (which !== 'positive' && which !== 'negative') return false;
    originState.chosen = which;
    originState.step = 'confirm';
    renderWizard();
    setStatus('+Z set to the ' + (which === 'positive' ? 'red' : 'blue') +
        ' arrow — ' + STEP_TEXT.confirm);
    return true;
}

/** Cancel: back to step 1, still in the mode. Exit is the way out entirely. */
export function cancelOriginPick() {
    if (!originState.active) return;
    resetPicks();
    renderWizard();
    setStatus('Origin pick cancelled — ' + STEP_TEXT.node);
}

/**
 * Continue: build the frame, re-base the displayed grid, report the transform.
 *
 * Leaves the mode afterwards. The result table lives in the (normal) plane
 * panel, so staying in a mode that locks every button would hide the very
 * thing the user just asked for.
 */
export function applyOrigin() {
    if (!originState.active || originState.step !== 'confirm') return null;
    var n = originState.normal;
    var z = originState.chosen === 'negative' ? [-n[0], -n[1], -n[2]] : [n[0], n[1], n[2]];

    var frame = buildOriginFrame(originState.originPoint, z);
    if (!frame) {
        setStatus('Could not build a frame from that corner and direction', 'warning');
        return null;
    }

    var plane = getPlane(originState.planeId);
    frame.sourcePlane = plane ? plane.name : null;
    frame.sourceNode = plane ? planeNodeNameAt(plane, originState.nodeIdx) : null;
    originState.frame = frame;
    markDirty();

    if (viewport3d) viewport3d.setOriginFrame(frame);
    exitOriginMode();
    renderOriginResult();
    setStatus('Origin set on "' + frame.sourcePlane + '" — translation ' +
        fmtVec(frame.origin) + ' mm, rotation ' + frame.angleDeg.toFixed(2) + '° about ' +
        fmtVec(frame.axis), 'success');
    return frame;
}

/**
 * Reset, behind a warning.
 *
 * The Danger Zone's entry point. `clearOrigin` itself stays unguarded so the
 * load path and the tests can reach it without a dialog — the confirmation is
 * about an unrecoverable CLICK, not about the operation.
 *
 * Unrecoverable is the operative word: the frame is derived from a corner and
 * an arrow the user picked in the 3D view, and nothing records which ones, so
 * rebuilding it means walking the wizard again and hoping for the same corner.
 */
export function confirmClearOrigin() {
    if (!originState.frame) return;
    var f = originState.frame;
    showPlaneDialog({
        title: 'Reset to Calibration Origin?',
        message: 'This discards the origin defined at "' + f.sourceNode + '" on plane "' +
            f.sourcePlane + '" and puts the 3D view back on the calibration frame',
        confirmLabel: 'Reset Origin',
        onConfirm: clearOrigin,
    });
}

/** Drop the user frame and put the grid back on the calibration origin. */
export function clearOrigin() {
    if (originState.frame) markDirty();
    originState.frame = null;
    if (viewport3d) viewport3d.setOriginFrame(null);
    renderOriginResult();
    setStatus('Origin reset to the calibration frame');
}

// ============================================
// Danger Zone — the actions that leave this app
// ============================================

/**
 * Write `calibration-updated.toml`: every camera's extrinsics re-expressed in
 * the defined origin.
 *
 * This is the other half of the deliverable. Applying an origin deliberately
 * does NOT move any annotated point (see the module note), so the 3D the user
 * exports is still in calibration-world coordinates — which is only coherent if
 * whoever consumes it also gets a calibration that agrees on where the world
 * is. Rewriting the calibration is how the origin leaves this app; rewriting
 * the points would silently change every number the rest of LUCID reports.
 *
 * Intrinsics, distortion, image size and camera ORDER all ride through
 * untouched — the file differs from its input in exactly two keys per camera,
 * so a diff against the original shows the origin change and nothing else.
 *
 * The rotation keeps the SHAPE it arrived in: a calibration that stored a 3x3
 * (anipose) gets a 3x3 back, one that stored a Rodrigues triple gets a triple.
 * Both are read by `Camera.rotationMatrix`, but silently changing the
 * representation would make the file stop matching its siblings in a rig's
 * config directory.
 */
export function exportUpdatedCalibration() {
    var f = originState.frame;
    if (!f) {
        setStatus('Define an origin first — there is nothing to re-base the calibration onto', 'warning');
        return null;
    }
    var cams = state.session && state.session.cameras;
    if (!cams || !cams.length) {
        setStatus('No calibration loaded to export', 'error');
        return null;
    }

    var out = [];
    for (var i = 0; i < cams.length; i++) {
        var c = cams[i];
        var reb = rebaseExtrinsics(c.rotationMatrix, c.tvec, f);
        if (!reb) {
            setStatus('Camera "' + c.name + '" has extrinsics that cannot be re-based', 'error');
            return null;
        }
        var asMatrix = Array.isArray(c.rvec) && Array.isArray(c.rvec[0]);
        out.push(new Camera(c.name, c.matrix, c.dist,
            asMatrix ? reb.R : reb.rvec, reb.tvec, c.size));
    }

    var toml = exportCalibrationTOML(out);
    downloadTOML(toml, 'calibration-updated.toml');
    setStatus('Exported calibration-updated.toml — ' + out.length +
        ' camera' + (out.length === 1 ? '' : 's') + ' re-based on "' + f.sourceNode + '"', 'success');
    return toml;
}

// ============================================
// The result readout
// ============================================

function fmt(v) {
    if (!isFinite(v)) return '—';
    return (Math.abs(v) < 1e-9 ? 0 : v).toFixed(3);
}

function fmtVec(v) {
    return '(' + v.map(fmt).join(', ') + ')';
}

/**
 * Render the transform into the panel.
 *
 * Both the origin's position AND the mapping's translation are shown, labelled.
 * They are different vectors (`t = -R·origin`) and swapping them silently
 * breaks any downstream use, so naming only one "translation" would be a trap.
 */
export function renderOriginResult() {
    var section = document.getElementById('originResultSection');
    var host = document.getElementById('originResult');
    // All three Danger Zone actions are relative to a defined origin — export
    // and Set would write the calibration back out unchanged, and Reset has
    // nothing to reset — so the block shares the readout's visibility gate
    // rather than offering three no-ops.
    var danger = document.getElementById('originDangerSection');
    if (!section || !host) return;

    var f = originState.frame;
    if (!f) {
        section.style.display = 'none';
        if (danger) danger.style.display = 'none';
        host.innerHTML = '';
        return;
    }
    section.style.display = '';
    if (danger) danger.style.display = '';
    host.innerHTML = '';

    var src = document.createElement('div');
    src.className = 'origin-source';
    src.textContent = 'Origin at "' + f.sourceNode + '" on plane "' + f.sourcePlane + '"';
    host.appendChild(src);

    var conv = document.createElement('div');
    conv.className = 'origin-convention';
    conv.textContent = 'p_new = R · p_old + t';
    host.appendChild(conv);

    [
        ['Origin (old frame)', f.origin, 'mm'],
        ['Translation t', f.translation, 'mm'],
        ['Rotation vector', f.rotationVector, 'rad'],
        ['Rotation axis', f.axis, ''],
        ['+X axis', f.xAxis, ''],
        ['+Y axis', f.yAxis, ''],
        ['+Z axis', f.zAxis, ''],
    ].forEach(function (row) {
        host.appendChild(vectorBlock(row[0], row[1], row[2]));
    });

    var ang = document.createElement('div');
    ang.className = 'origin-angle';
    ang.textContent = 'Rotation angle: ' + f.angleDeg.toFixed(3) + '°';
    host.appendChild(ang);

    var mt = document.createElement('table');
    mt.className = 'origin-table origin-matrix';
    for (var r = 0; r < 3; r++) {
        var tr = document.createElement('tr');
        for (var c = 0; c < 3; c++) {
            var td = document.createElement('td');
            td.textContent = fmt(f.R[r][c]);
            tr.appendChild(td);
        }
        mt.appendChild(tr);
    }
    // The matrix gets the same name-then-indented-body shape as the vectors, so
    // its long caption can wrap onto its own lines instead of setting a width
    // the 3x3 then has to live inside.
    host.appendChild(namedBlock(
        'Rotation matrix R (rows = new axes in old coordinates)', '', mt, 'origin-matrix-label'));
}

/**
 * One labelled row of the readout: the NAME on its own line, its values
 * indented underneath.
 *
 * The readout used to be a 5-column table (name | x | y | z | unit), which is
 * wider than this ~300px panel — the unit column was clipped off the right
 * edge. Stacking is what buys the width back, and it also matches the Nodes
 * list in the same panel, which stacks a node's x/y/z under its name for the
 * same reason. Hence the shared `.plane-node-xyz-*` layout classes: one
 * full-width line of three labelled cells.
 */
function namedBlock(label, unit, body, extraNameClass) {
    var block = document.createElement('div');
    block.className = 'origin-block';

    var name = document.createElement('div');
    name.className = 'origin-row-name' + (extraNameClass ? ' ' + extraNameClass : '');
    name.appendChild(document.createTextNode(label));
    if (unit) {
        // The unit rides with the NAME rather than trailing the numbers: it
        // describes the whole vector, and as a column it was the part that did
        // not fit.
        var u = document.createElement('span');
        u.className = 'origin-unit';
        u.textContent = unit;
        name.appendChild(u);
    }
    block.appendChild(name);

    var bodyWrap = document.createElement('div');
    bodyWrap.className = 'origin-block-body';
    bodyWrap.appendChild(body);
    block.appendChild(bodyWrap);
    return block;
}

function vectorBlock(label, v, unit) {
    var line = document.createElement('div');
    line.className = 'plane-node-xyz-line';
    ['x', 'y', 'z'].forEach(function (axis, i) {
        var cell = document.createElement('span');
        cell.className = 'plane-node-xyz-cell';
        var lab = document.createElement('span');
        lab.className = 'plane-node-xyz-label';
        lab.textContent = axis;
        var val = document.createElement('span');
        // Deliberately a span, not the Nodes list's <input>: these are computed
        // outputs of the transform, and a field that looks typeable but is not
        // would be a lie about what the panel does.
        val.className = 'origin-xyz-value';
        val.textContent = fmt(v[i]);
        cell.appendChild(lab);
        cell.appendChild(val);
        line.appendChild(cell);
    });
    return namedBlock(label, unit, line);
}

// ============================================
// Wiring
// ============================================

/** Called once from `setupPlaneDefinition`. */
export function setupOriginDefinition() {
    var exit = document.getElementById('originModeExit');
    if (exit) exit.addEventListener('click', function () {
        exitOriginMode();
        setStatus('Left Set Origin Mode');
    });

    var cancel = document.getElementById('btnOriginCancel');
    if (cancel) cancel.addEventListener('click', cancelOriginPick);

    var cont = document.getElementById('btnOriginContinue');
    if (cont) cont.addEventListener('click', applyOrigin);

    // Reset goes through the warning, not straight to `clearOrigin` — it is the
    // one button here that destroys something the user cannot get back by
    // clicking again.
    var clear = document.getElementById('btnClearOrigin');
    if (clear) clear.addEventListener('click', confirmClearOrigin);

    var exportCal = document.getElementById('btnExportCalibration');
    if (exportCal) exportCal.addEventListener('click', exportUpdatedCalibration);

    // The committing twin of Export: it writes the calibration over the file on
    // disk AND re-bases every 3D point in the project. Its dialogs, progress
    // bar and file write live in `ui/origin-rebase.js`.
    var setCal = document.getElementById('btnSetCalibration');
    if (setCal) setCal.addEventListener('click', showSetCalibrationModal);

    setupInstructionDrag();

    renderOriginResult();
}

/**
 * Install the 3D pick callbacks. Called from `syncPlanes3D`, alongside the
 * plane-drag callbacks, so it survives a viewport re-creation.
 */
export function attachOriginCallbacks(vp) {
    if (!vp) return;
    vp.onOriginNodePicked = function (planeId, nodeIdx) {
        pickOriginNode(planeId, nodeIdx);
    };
    vp.onOriginAxisPicked = function (which) {
        pickOriginAxis(which);
    };
    // A re-created viewport comes back on the calibration frame. Re-apply the
    // user's, or loading a session would silently throw their origin away while
    // the panel still reported it.
    if (originState.frame) vp.setOriginFrame(originState.frame);
}
