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
// not a rewritten point cloud — is the deliverable. Nothing here is persisted
// to the `.slp` yet, so like plane placements it does not call `markDirty()`.

import { state, viewport3d } from './app-state.js';
import { setStatus } from '../import-export/save-load.js';
import { buildOriginFrame } from '../pose/origin-frame.js';
import { getPoint3d, hasPoint3d } from '../pose/pose-data.js';
// Circular by design (plane-definition imports this module's `enterOriginMode`
// for its button). Safe: every use is inside a function body, so the binding
// resolves at call time.
import {
    planeState, planeModel, getPlane, planePoints3d, planeNodeNameAt, syncPlanes3D,
} from './plane-definition.js';

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

    if (viewport3d) viewport3d.setOriginFrame(frame);
    exitOriginMode();
    renderOriginResult();
    setStatus('Origin set on "' + frame.sourcePlane + '" — translation ' +
        fmtVec(frame.origin) + ' mm, rotation ' + frame.angleDeg.toFixed(2) + '° about ' +
        fmtVec(frame.axis), 'success');
    return frame;
}

/** Drop the user frame and put the grid back on the calibration origin. */
export function clearOrigin() {
    originState.frame = null;
    if (viewport3d) viewport3d.setOriginFrame(null);
    renderOriginResult();
    setStatus('Origin reset to the calibration frame');
}

// ============================================
// The result table
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
    if (!section || !host) return;

    var f = originState.frame;
    if (!f) {
        section.style.display = 'none';
        host.innerHTML = '';
        return;
    }
    section.style.display = '';
    host.innerHTML = '';

    var src = document.createElement('div');
    src.className = 'origin-source';
    src.textContent = 'Origin at "' + f.sourceNode + '" on plane "' + f.sourcePlane + '"';
    host.appendChild(src);

    var conv = document.createElement('div');
    conv.className = 'origin-convention';
    conv.textContent = 'p_new = R · p_old + t';
    host.appendChild(conv);

    host.appendChild(vectorTable([
        ['Origin (old frame)', f.origin, 'mm'],
        ['Translation t', f.translation, 'mm'],
        ['Rotation vector', f.rotationVector, 'rad'],
        ['Rotation axis', f.axis, ''],
        ['+X axis', f.xAxis, ''],
        ['+Y axis', f.yAxis, ''],
        ['+Z axis', f.zAxis, ''],
    ]));

    var ang = document.createElement('div');
    ang.className = 'origin-angle';
    ang.textContent = 'Rotation angle: ' + f.angleDeg.toFixed(3) + '°';
    host.appendChild(ang);

    var mLabel = document.createElement('div');
    mLabel.className = 'origin-matrix-label';
    mLabel.textContent = 'Rotation matrix R (rows = new axes in old coordinates)';
    host.appendChild(mLabel);

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
    host.appendChild(mt);
}

function vectorTable(rows) {
    var table = document.createElement('table');
    table.className = 'origin-table';
    var head = document.createElement('tr');
    ['', 'x', 'y', 'z', ''].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
    });
    table.appendChild(head);
    rows.forEach(function (row) {
        var tr = document.createElement('tr');
        var name = document.createElement('td');
        name.className = 'origin-row-name';
        name.textContent = row[0];
        tr.appendChild(name);
        for (var i = 0; i < 3; i++) {
            var td = document.createElement('td');
            td.textContent = fmt(row[1][i]);
            tr.appendChild(td);
        }
        var unit = document.createElement('td');
        unit.className = 'origin-unit';
        unit.textContent = row[2];
        tr.appendChild(unit);
        table.appendChild(tr);
    });
    return table;
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

    var clear = document.getElementById('btnClearOrigin');
    if (clear) clear.addEventListener('click', clearOrigin);

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
