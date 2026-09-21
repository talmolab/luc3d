// ui/plane-angle.js — the "Set Angle Between Two Planes" dialog and commit.
//
// The UI half of `pose/plane-angle.js`. That module plans (purely); this one
// asks the user, previews, and commits — the same plan/apply split
// `planPlaneFit` / `applyPlaneFit` uses, and for the same reason: the geometry
// has to be inspectable and refusable before anything is written.
//
// WHY A MODAL RATHER THAN A MODE. Set Origin is a wizard because its inputs are
// PICKED in the 3D view (a corner, then an axis arrow). This action's inputs are
// two planes and a number, which a form states better than a sequence of
// clicks — and it could not be picked in 3D as things stand anyway: the plane
// FILL meshes carry no `userData`, so only corners are raycastable and there is
// no "click a plane" gesture to reuse.
//
// WHAT THE COMMIT DOES, in order, because the order is load-bearing:
//
//   1. write the rotated 3D through `writePoints3dForPlane` — the one
//      sanctioned publish path, which skips LOCKED nodes and routes
//      PLANE-LOCKED ones through `constrainPoint3dForNode`.
//   2. install the ROTATED fit rather than re-fitting. A re-fit would
//      re-derive the normal's sign from `jacobiEigen` and could flip it; see
//      `rotatePlaneFit`.
//   3. reproject the moved corners into every 2D view the plane is placed on,
//      exactly as `applyPlaneFit` does, so the annotation agrees with the 3D.
//   4. clear the stored fit of any OTHER plane whose nodes moved — it was
//      solved against positions that no longer hold.
//   5. hold the moved nodes PLANE-LOCKED to this plane. That is what makes the
//      angle durable: without it the next Triangulate re-solves those corners
//      from 2D and silently throws the angle away. Plane-locked rather than
//      Locked because the assertion is about the plane's ORIENTATION — the
//      corners may still be re-solved, and land back on this plane. It happens
//      LAST because until step 2 the stored fit is still the old one.
//
// Every mutation goes through one `markDirty()`, per the standing rule.
//
// THE EDIT LOCK. The dialog is not modal — the 3D view stays orbitable while it
// is open, which is the whole point of the live ghost. But "interactive" is not
// "editable": everything the dialog says (the current angle, the hinge, the
// ghost's shape) is read from plane geometry, so letting that geometry change
// underneath it produces a readout describing a scene that no longer exists and
// a ghost drawn from stale corners. So while the dialog is up, plane DATA is
// frozen:
//
//   - `refreshPlanePanel` disables the Define Plane panel's controls,
//   - `syncPlanes3D` pushes `editable: false`, which makes 3D corners inert
//     (no drag, and no `move` cursor advertising one),
//   - `beginPlaneDrag` refuses a 2D corner drag, saying why — with the
//     `isPlaneDataLocked` callback and a guard in `handlePlaneDrop` closing the
//     two 2D paths that do not go through it: the right-click null toggle
//     (which invalidates the node's 3D) and a plane row dropped onto a view (a
//     `<tr>` takes no `disabled`).
//
// They all ask `isAngleModalOpen()` rather than being toggled by hand, so
// there is no lock state to get out of step and a mid-dialog re-render cannot
// leak an unlocked control. Orbiting, zooming, panning and selection stay live,
// and so does pose annotation — it cannot touch a plane.

import {
    planeModel, planeState, refreshPlanePanel, syncPlanes3D,
    showPlaneDialog, refreshTriangulationErrors,
} from './plane-definition.js';
import { writePoints3dForPlane, points3dForPlane } from '../pose/plane-data.js';
import { reprojectPointCamera, fitPlaneToPoints3d } from '../pose/triangulation.js';
import { planAngleEdit, planeAngleDeg } from '../pose/plane-angle.js';
import { state, viewport3d } from './app-state.js';
import { setStatus, markDirty } from '../import-export/save-load.js';
import { drawAllOverlays } from './rendering.js';

/** The angle the dialog opens on. 90 is what "square this up" means. */
const DEFAULT_TARGET_DEG = 90;

/**
 * The two role colours, used in BOTH places at once: the swatch beside each
 * dropdown and the outline drawn round that plane in the 3D view. That pairing
 * is the whole mechanism — the dropdown says a NAME and the viewport says a
 * SHAPE, and nothing joins them up unless they share a colour.
 *
 * Deliberately not the planes' own colours, which are the user's and would make
 * "held" and "moves" mean something different in every project. Cool for the
 * one that stays put, warm for the one about to move.
 */
const ROLE_FIXED_COLOR = '#4da3ff';
const ROLE_MOVING_COLOR = '#ffd24d';

/** Module-level handle so Esc / Cancel / Apply all tear down the same overlay. */
var angleOverlay = null;

// ============================================
// Which planes this action can work on
// ============================================

/**
 * The plane to measure `plane` by: its stored fit, else one derived now.
 *
 * `fittedPlanes()` — what Set Origin asks — is the wrong question here, and
 * asking it listed 2 of a user's 5 annotated planes. A plane loses its stored
 * `planeFit` for reasons that have nothing to do with whether it HAS a plane:
 * pinning a node clears the fit of every plane standing on that node, and a
 * plane that was triangulated but never Fitted never had one. All five of those
 * planes held 3D on every corner; three of them simply had no cached fit.
 *
 * Set Origin genuinely needs the stored fit (it offers that plane's corners as
 * an origin). This action only needs to know WHERE the plane is, which its
 * triangulated corners already say. So the fit is derived on demand — the same
 * total-least-squares fit `Fit` computes, and nothing is written: deriving it
 * is a measurement, and opening a dialog must not mutate the project.
 *
 * The plain fit rather than the constrained one, deliberately. This value is
 * rotated with the points (`rotatePlaneFit`), and a TLS fit is exactly
 * equivariant under a rigid motion — rotate the corners, and the fit of the
 * rotated corners IS the rotated fit. An anchor-constrained fit is not.
 *
 * @param {PlaneSkeleton} plane
 * @param {PlaneModel} model
 * @returns {Object|null} null when the plane has fewer than 3 solved corners,
 *   or they are coincident or collinear.
 */
export function usableFit(plane, model) {
    if (!plane) return null;
    if (plane.planeFit) return plane.planeFit;
    if (!model) return null;
    return fitPlaneToPoints3d(points3dForPlane(plane, model.pool));
}

/**
 * Every plane this dialog can offer: one that has a usable fit, stored or not.
 *
 * @returns {PlaneSkeleton[]} in model order, so the dropdowns read the way the
 *   Planes list does.
 */
export function anglePlanes() {
    var model = planeModel();
    if (!model) return [];
    return model.planes.filter(function (p) { return !!usableFit(p, model); });
}

/** The pair of fits for a fixed/moving pair, in `planAngleEdit`'s shape. @private */
function fitsFor(fixedPlane, movingPlane, model) {
    return {
        fixed: usableFit(fixedPlane, model),
        moving: usableFit(movingPlane, model),
    };
}

// ============================================
// Commit
// ============================================

/**
 * Commit a plan from `planAngleEdit`.
 *
 * @param {Object} plan - An `ok` plan. A refused one must never reach here.
 * @param {PlaneSkeleton} fixedPlane
 * @param {PlaneSkeleton} movingPlane
 * @returns {{ok:boolean, movedPx:number, skippedNames:string[],
 *            constrainedNames:string[], heldNames:string[],
 *            stalePlaneNames:string[], achievedDeg:number|null}}
 */
export function applyAngleEdit(plan, fixedPlane, movingPlane) {
    var model = planeModel();
    var pool = model.pool;

    // 1. the 3D. The hook is what makes a plane-locked node land back in its
    //    own plane instead of following the rotation out of it.
    var written = writePoints3dForPlane(movingPlane, pool, plan.after, {
        constrain: function (id, xyz) { return model.constrainPoint3dForNode(id, xyz); },
    });

    // 2. the fit, rotated rather than re-derived. When the moving plane had no
    //    stored fit, this is the derived one (`usableFit`) rotated — so a plane
    //    the user never pressed Fit on comes out of this holding a real fit,
    //    which is honest: it is where its corners now are.
    if (plan.newMovingFit) movingPlane.planeFit = plan.newMovingFit;

    // 3. push the correction into every 2D view this plane is placed on.
    var moved = {};
    for (var mi = 0; mi < plan.movedNodeIds.length; mi++) moved[plan.movedNodeIds[mi]] = true;
    var session = state.session;
    var movedSum = 0, movedCount = 0;
    if (session && session.cameras) {
        for (var c = 0; c < session.cameras.length; c++) {
            var cam = session.cameras[c];
            if (!model.isPlanePlaced(movingPlane, cam.name)) continue;
            var inst = model.getInstance(cam.name);
            if (!inst) continue;
            for (var k = 0; k < movingPlane.nodeIds.length; k++) {
                var id = movingPlane.nodeIds[k];
                // Only the corners that actually moved. A hinge corner's 2D is
                // the user's annotation of a point that did not move, so
                // rewriting it would replace their observation with the
                // model's opinion of it for no reason.
                if (!moved[id]) continue;
                var node = pool.getNode(id);
                if (!node || !node.hasPoint3d()) continue;
                // A locked node cannot have moved, but a refused write would
                // leave 3D and 2D disagreeing if one ever did.
                if (node.immutable) continue;
                var pi = pool.indexOf(id);
                if (pi < 0 || pi >= inst.numNodes) continue;
                // Reproject the node's ACTUAL position, not the plan's: the
                // constrain hook may have moved a plane-locked node off it.
                // `reprojectPointCamera` applies lens distortion, because 2D
                // annotations live in the camera's native pixel space.
                var uv = reprojectPointCamera(node.getPoint3d(), cam);
                if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
                if (inst.hasPoint(pi) && !inst.isNodeDerived(pi)) {
                    var dx = uv[0] - inst.getX(pi);
                    var dy = uv[1] - inst.getY(pi);
                    movedSum += Math.sqrt(dx * dx + dy * dy);
                    movedCount++;
                }
                inst.setPoint(pi, uv[0], uv[1]);
            }
            inst.modified = true;
        }
    }

    // 4. a shared node that moved silently breaks the OTHER plane's fit.
    var stalePlaneNames = [];
    for (var s = 0; s < plan.stalePlaneIds.length; s++) {
        var other = model.getPlane(plan.stalePlaneIds[s]);
        if (!other || !other.planeFit) continue;
        other.planeFit = null;
        stalePlaneNames.push(other.name);
    }

    // 5. HOLD what moved in the plane we just set — `plane-locked`, not
    //    `locked`. What the user asserted is the PLANE's orientation, not where
    //    each corner sits on it, and those are different promises: a
    //    plane-locked corner is still re-solved from 2D, and
    //    `constrainPoint3dForNode` projects the answer back onto this plane's
    //    fit. So Triangulate goes on refining the annotation while the angle
    //    survives, instead of the corners being frozen outright and every later
    //    solve of this plane being a no-op the user has to unpin their way out
    //    of. A node the user had already Locked is left Locked: that is a
    //    stronger promise they made deliberately, and weakening it here would
    //    be this action quietly undoing their pin.
    //
    //    Still LAST. Step 1 writes through the same constrain hook, and until
    //    step 2 the plane's stored fit is the OLD one — a node pinned any
    //    earlier would have had its rotation projected straight back onto the
    //    plane it was being rotated off.
    var heldNames = [];
    for (var L = 0; L < plan.movedNodeIds.length; L++) {
        var nd = pool.getNode(plan.movedNodeIds[L]);
        if (!nd || nd.pin === 'locked') continue;
        pool.setPin(nd.id, 'plane-locked', movingPlane.id);
        heldNames.push(nd.name);
    }

    // The stored triangulation summary is no longer the whole story — the 3D
    // moved and the 2D was rewritten to match, so re-derive the errors.
    refreshTriangulationErrors(movingPlane);

    var nameOf = function (id) {
        var n = pool.getNode(id);
        return n ? n.name : String(id);
    };

    // Measured after step 4, which may have cleared the FIXED plane's stored
    // fit — `usableFit` then re-derives it from where its corners are now,
    // which is the state the readout should report either way.
    var fitF = usableFit(fixedPlane, model);
    var fitM = usableFit(movingPlane, model);
    var achieved = planeAngleDeg(
        fitF ? fitF.normal : null,
        fitM ? fitM.normal : null);

    markDirty();
    syncPlanes3D();
    refreshPlanePanel();
    drawAllOverlays();

    return {
        ok: true,
        movedPx: movedCount > 0 ? movedSum / movedCount : 0,
        skippedNames: written.skippedIds.map(nameOf),
        constrainedNames: written.constrainedIds.map(nameOf),
        heldNames: heldNames,
        stalePlaneNames: stalePlaneNames,
        achievedDeg: achieved,
    };
}

/** Status-bar report for a committed edit. @private */
function reportAngleEdit(fixedPlane, movingPlane, plan, res) {
    planeState.expanded.add(movingPlane.id);
    var msg = 'Set "' + movingPlane.name + '" to ' + plan.targetDeg.toFixed(2) +
        '° from "' + fixedPlane.name + '" (was ' + plan.currentDeg.toFixed(2) +
        '°; rotated ' + Math.abs(plan.deltaDeg).toFixed(2) + '° about ' +
        (plan.axis.kind === 'edge' ? 'their shared edge'
            : plan.axis.kind === 'node' ? 'their shared corner'
            : 'the plane centroid') + ')';
    if (res.movedPx) msg += '; corners moved ' + res.movedPx.toFixed(1) + ' px in 2D';
    if (res.heldNames.length) {
        msg += '. ' + res.heldNames.length + ' node(s) are now Plane-locked to "' +
            movingPlane.name + '", so a re-solve may still move them but only ' +
            'within it — the angle survives';
    }
    if (res.constrainedNames.length) {
        msg += '. ' + res.constrainedNames.length + ' Plane-locked node(s) were held ' +
            'in their own plane';
    }
    var warn = false;
    if (res.achievedDeg !== null && Math.abs(res.achievedDeg - plan.targetDeg) > 1e-3) {
        msg += '. The result is ' + res.achievedDeg.toFixed(2) + '°, not ' +
            plan.targetDeg.toFixed(2) + '°, because a constraint held some nodes back';
        warn = true;
    }
    if (res.stalePlaneNames.length) {
        msg += '. It moved shared nodes, so the fit of ' +
            res.stalePlaneNames.map(function (n) { return '"' + n + '"'; }).join(', ') +
            ' is now stale — re-fit ' + (res.stalePlaneNames.length === 1 ? 'it' : 'them');
        warn = true;
    }
    setStatus(msg, warn ? 'warning' : 'success');
}

// ============================================
// The button
// ============================================

/**
 * Enable/disable `#btnSetPlaneAngle`, explaining why in its `title`.
 *
 * Modelled on `renderOriginButton`. TWO usable planes are needed, not one: an
 * angle is a relationship, and the dialog's two dropdowns would otherwise have
 * nothing to choose between. Usable, not fitted — see `usableFit`.
 */
export function renderAngleButton() {
    var btn = document.getElementById('btnSetPlaneAngle');
    if (!btn) return;
    var n = anglePlanes().length;
    btn.disabled = n < 2;
    btn.title = n < 2
        ? 'Triangulate at least two planes first — an angle is between two of ' +
          'them (' + n + ' usable so far)'
        : 'Rotate one plane about its shared edge with another until they meet ' +
          'at an angle you type (0° = parallel, 90° = perpendicular)';
}

// ============================================
// The dialog
// ============================================

/**
 * Tear the dialog down, clearing the 3D preview with it.
 *
 * Exported because leaving Defining Plane Mode has to take the dialog with it,
 * the same way `exitPlaneMode` already unwinds Set Origin Mode: this dialog
 * edits plane geometry and holds the panel locked, so outliving its own mode
 * would strand both.
 *
 * The two refreshes at the end are what LIFT the lock — see `refreshPlanePanel`
 * (panel controls) and `syncPlanes3D` (`editable`, which re-arms 3D corner
 * dragging). Both read `isAngleModalOpen()`, so they must run after the handle
 * is nulled, and both are idempotent when the dialog was not open.
 */
export function closeAngleModal() {
    if (viewport3d && viewport3d.clearAnglePreview) viewport3d.clearAnglePreview();
    if (viewport3d && viewport3d.clearPlaneRoles) viewport3d.clearPlaneRoles();
    if (!angleOverlay) return;
    document.removeEventListener('keydown', onAngleKeyDown, true);
    if (angleOverlay.parentNode) angleOverlay.remove();
    angleOverlay = null;
    refreshPlanePanel();
    syncPlanes3D();
}

/**
 * Esc cancels — per the app-wide modal convention (CLAUDE.md > Modals). Capture
 * phase, so it wins over the app's own keydown handlers, and it CANCELS rather
 * than confirming: nothing has been written while the dialog is open.
 * @private
 */
function onAngleKeyDown(e) {
    if (!angleOverlay) return;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeAngleModal();
}

/**
 * Let the user drag the dialog by its title.
 *
 * The whole point of this dialog is the ghost it draws in the 3D view, and a
 * centred modal covers part of that view — so it has to be movable, the same
 * way `ui/origin-definition.js` makes its instruction box draggable for exactly
 * this reason. Pointer capture rather than document listeners, so a fast drag
 * that leaves the header keeps tracking; and the overlay's flex centring is
 * swapped for absolute positioning on the first move, not before, so a dialog
 * nobody drags stays centred.
 * @private
 */
function makeDraggableByHeader(modal, header) {
    var grab = null;
    header.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        var r = modal.getBoundingClientRect();
        grab = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        modal.style.position = 'absolute';
        modal.style.margin = '0';
        modal.style.left = r.left + 'px';
        modal.style.top = r.top + 'px';
        header.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    header.addEventListener('pointermove', function (e) {
        if (!grab) return;
        // Clamp so the dialog can never be dragged fully off-screen, which
        // would leave no way to reach Cancel.
        var w = modal.offsetWidth, h = modal.offsetHeight;
        var x = Math.max(8 - w + 60, Math.min(window.innerWidth - 60, e.clientX - grab.dx));
        var y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - grab.dy));
        modal.style.left = x + 'px';
        modal.style.top = y + 'px';
    });
    header.addEventListener('pointerup', function (e) {
        grab = null;
        if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId);
    });
    header.addEventListener('pointercancel', function () { grab = null; });
}

/**
 * Park the dialog to the LEFT of the 3D viewport instead of centring it.
 *
 * Centred, it sat on top of the one thing it exists to show. The ghost, the
 * role outlines and the orbiting the user now does while it is open are all in
 * the 3D view, so the dialog opens beside that view and the header still drags
 * it anywhere else. If there is no room on the left (a narrow window, or no 3D
 * pane at all) it falls back to the left edge of the screen rather than off it:
 * overlapping something is recoverable, being unreachable is not.
 *
 * Called after the modal is in the DOM, because it needs a measured width.
 * @private
 */
function parkBesideViewport(modal) {
    var host = document.getElementById('viewport3dContainer');
    var r = host ? host.getBoundingClientRect() : null;
    var w = modal.offsetWidth || 440;
    var h = modal.offsetHeight || 320;
    var x, y;
    if (r && r.width > 0 && r.height > 0) {
        x = r.left - w - 12;
        y = r.top + 12;
    } else {
        x = Math.round((window.innerWidth - w) / 2);
        y = Math.round((window.innerHeight - h) / 2);
    }
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    y = Math.max(8, Math.min(Math.max(8, window.innerHeight - h - 8), y));
    modal.style.position = 'absolute';
    modal.style.margin = '0';
    modal.style.left = Math.round(x) + 'px';
    modal.style.top = Math.round(y) + 'px';
}

/** A `<select>` of the fitted planes. @private */
function planeSelect(id, planes, selectedId) {
    var sel = document.createElement('select');
    sel.className = 'plane-select';
    sel.id = id;
    for (var i = 0; i < planes.length; i++) {
        var opt = document.createElement('option');
        opt.value = String(planes[i].id);
        opt.textContent = planes[i].name;
        if (planes[i].id === selectedId) opt.selected = true;
        sel.appendChild(opt);
    }
    return sel;
}

/**
 * One `label: control` row. `swatchColor` tints a dot in front of the label,
 * matching the outline this row's plane wears in the 3D view.
 * @private
 */
function row(labelText, control, suffix, swatchColor) {
    var d = document.createElement('div');
    d.className = 'plane-angle-row';
    var lab = document.createElement('label');
    if (swatchColor) {
        var sw = document.createElement('span');
        sw.className = 'plane-angle-swatch';
        sw.style.background = swatchColor;
        lab.appendChild(sw);
    }
    lab.appendChild(document.createTextNode(labelText));
    if (control && control.id) lab.htmlFor = control.id;
    d.appendChild(lab);
    if (control) d.appendChild(control);
    if (suffix) {
        var sfx = document.createElement('span');
        sfx.className = 'plane-angle-suffix';
        sfx.textContent = suffix;
        d.appendChild(sfx);
    }
    return d;
}

/**
 * Open the dialog. Refuses up front rather than showing a form that cannot be
 * completed — the same courtesy `enterOriginMode` extends.
 */
export function showPlaneAngleModal() {
    if (angleOverlay) return;
    var planes = anglePlanes();
    if (planes.length < 2) {
        showPlaneDialog({
            title: 'Two triangulated planes are needed',
            message: 'Setting an angle needs two planes with at least three ' +
                'triangulated corners each — there ' +
                (planes.length === 1 ? 'is' : 'are') + ' currently ' +
                planes.length + '. Select a plane and press Triangulate, for ' +
                'each of the two you want.',
        });
        return;
    }

    var model = planeModel();

    // Default to the selected plane as the one that MOVES, since that is what
    // the user was just looking at, and hold the other as fixed.
    var movingId = planes.some(function (p) { return p.id === planeState.selectedPlaneId; })
        ? planeState.selectedPlaneId : planes[1].id;
    var fixedId = planes.filter(function (p) { return p.id !== movingId; })[0].id;

    angleOverlay = document.createElement('div');
    angleOverlay.className = 'plane-confirm-overlay';
    angleOverlay.id = 'planeAngleOverlay';
    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal plane-angle-modal';
    angleOverlay.appendChild(modal);

    var h3 = document.createElement('h3');
    h3.textContent = 'Set Angle Between Two Planes';
    h3.className = 'plane-angle-drag';
    h3.title = 'Drag to move this dialog out of the way of the 3D view';
    modal.appendChild(h3);
    makeDraggableByHeader(modal, h3);

    var fixedSel = planeSelect('planeAngleFixed', planes, fixedId);
    var movingSel = planeSelect('planeAngleMoving', planes, movingId);

    var swap = document.createElement('button');
    swap.className = 'plane-angle-swap';
    swap.id = 'btnPlaneAngleSwap';
    swap.type = 'button';
    swap.textContent = '⇄';
    swap.title = 'Swap which plane is held fixed and which one moves';

    var fixedRow = row('Fixed plane', fixedSel, null, ROLE_FIXED_COLOR);
    fixedRow.appendChild(swap);
    modal.appendChild(fixedRow);
    modal.appendChild(row('Moving plane', movingSel, null, ROLE_MOVING_COLOR));

    var readout = document.createElement('div');
    readout.className = 'plane-angle-readout';
    readout.id = 'planeAngleReadout';
    modal.appendChild(readout);

    var target = document.createElement('input');
    target.type = 'number';
    target.id = 'planeAngleTarget';
    target.className = 'plane-angle-input';
    target.min = '0';
    target.max = '90';
    target.step = '0.1';
    target.value = String(DEFAULT_TARGET_DEG);
    modal.appendChild(row('Target angle', target, '°'));

    var hint = document.createElement('div');
    hint.className = 'plane-angle-hint';
    hint.textContent = '0° = parallel, 90° = perpendicular. ' +
        'The plane is rotated the shortest way round, so it stays on the side it is on.';
    modal.appendChild(hint);

    var warnBox = document.createElement('div');
    warnBox.className = 'plane-angle-warn';
    warnBox.id = 'planeAngleWarn';
    modal.appendChild(warnBox);

    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    var cancel = document.createElement('button');
    cancel.id = 'btnPlaneAngleCancel';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    var apply = document.createElement('button');
    apply.id = 'btnPlaneAngleApply';
    apply.type = 'button';
    apply.className = 'primary';
    apply.textContent = 'Apply';
    actions.appendChild(cancel);
    actions.appendChild(apply);
    modal.appendChild(actions);

    // --- the live plan ------------------------------------------------------
    // Recomputed on every input change. It is pure, so doing this on each
    // keystroke costs nothing and writes nothing; `lastPlan` is what Apply
    // commits, so Apply can never act on a staler state than the readout shows.
    var lastPlan = null;

    function currentPlanes() {
        return {
            fixed: model.getPlane(Number(fixedSel.value)),
            moving: model.getPlane(Number(movingSel.value)),
        };
    }

    function refresh() {
        var pair = currentPlanes();
        var raw = target.value.trim();
        var deg = Number(raw);
        // Derived here rather than inside the planner: the planner cannot
        // import `fitPlaneToPoints3d` without losing its stub-free
        // testability, so the UI hands it the fits. See `usableFit`.
        var fits = fitsFor(pair.fixed, pair.moving, model);
        var pl = (raw === '' || !isFinite(deg))
            ? { ok: false, code: 'bad_target', warnings: [],
                message: 'Type an angle between 0 and 90 degrees.' }
            : planAngleEdit(pair.fixed, pair.moving, deg, model, fits);
        lastPlan = pl;

        // The readout always reports the CURRENT state, even when the plan is
        // refused, so the user can see what they have before deciding.
        var cur = (fits.fixed && fits.moving)
            ? planeAngleDeg(fits.fixed.normal, fits.moving.normal)
            : null;
        readout.textContent = '';
        var curLine = document.createElement('div');
        curLine.textContent = 'Current angle: ' +
            (cur === null ? '—' : cur.toFixed(2) + '°');
        readout.appendChild(curLine);

        var hingeLine = document.createElement('div');
        if (pl.ok && pl.axis) {
            hingeLine.textContent = 'Hinge: ' + (
                pl.axis.kind === 'edge'
                    ? 'shared edge, ' + pl.axis.hingeIds.length + ' node(s) stay put'
                    : pl.axis.kind === 'node'
                        ? 'their one shared corner stays put'
                        : 'no shared corner — pivoting on the plane centroid');
            if (pl.movedNodeIds.length) {
                hingeLine.textContent += '; ' + pl.movedNodeIds.length + ' node(s) move';
            }
        } else {
            hingeLine.textContent = '';
        }
        readout.appendChild(hingeLine);

        warnBox.textContent = '';
        if (!pl.ok) {
            var err = document.createElement('div');
            err.className = 'plane-angle-error';
            err.textContent = pl.message;
            warnBox.appendChild(err);
        }
        for (var w = 0; w < (pl.warnings || []).length; w++) {
            var wd = document.createElement('div');
            wd.className = 'plane-angle-warning';
            wd.textContent = '⚠ ' + pl.warnings[w].message;
            // The line itself caps its name list so this narrow panel keeps its
            // width; `detail` is the same list untruncated, so hovering still
            // answers "which ones?" when there are more than the line shows.
            if (pl.warnings[w].detail) wd.title = pl.warnings[w].detail;
            warnBox.appendChild(wd);
        }

        apply.disabled = !pl.ok;
        apply.title = pl.ok ? '' : pl.message;

        // Which plane in the scene is which. Pushed on every refresh, not only
        // on open, because the dropdowns and the swap button change it — and
        // it survives a refused plan, since naming the two planes is exactly
        // what the user needs in order to fix one.
        if (viewport3d && viewport3d.setPlaneRoles) {
            var roles = [];
            if (pair.fixed) roles.push({ planeId: pair.fixed.id, color: ROLE_FIXED_COLOR });
            if (pair.moving) roles.push({ planeId: pair.moving.id, color: ROLE_MOVING_COLOR });
            viewport3d.setPlaneRoles(roles);
        }

        // The ghost. Cleared rather than left stale when the plan is refused.
        if (viewport3d && viewport3d.setAnglePreview) {
            if (pl.ok && pl.movedNodeIds.length) {
                viewport3d.setAnglePreview({
                    planeId: pair.moving.id,
                    points3d: pl.after,
                    color: pair.moving.color,
                });
            } else {
                viewport3d.clearAnglePreview();
            }
        }
    }

    // Keep the two dropdowns from naming the same plane: picking the moving
    // plane in the fixed slot swaps them rather than producing a dead form.
    function onFixedChange() {
        if (fixedSel.value === movingSel.value) {
            var other = planes.filter(function (p) { return String(p.id) !== fixedSel.value; })[0];
            if (other) movingSel.value = String(other.id);
        }
        refresh();
    }
    function onMovingChange() {
        if (fixedSel.value === movingSel.value) {
            var other = planes.filter(function (p) { return String(p.id) !== movingSel.value; })[0];
            if (other) fixedSel.value = String(other.id);
        }
        refresh();
    }

    fixedSel.addEventListener('change', onFixedChange);
    movingSel.addEventListener('change', onMovingChange);
    swap.addEventListener('click', function () {
        var f = fixedSel.value;
        fixedSel.value = movingSel.value;
        movingSel.value = f;
        refresh();
    });

    // Commit on `change`, and `stopPropagation` on every keydown so the app's
    // hotkeys do not fire while the user is typing a number into the field.
    target.addEventListener('input', refresh);
    target.addEventListener('change', function () {
        // Revert-on-invalid, the panel's convention: accept nothing rather than
        // commit a value the user did not mean. An EMPTY field is checked
        // before `Number`, which would read '' as 0 — a silent, plausible and
        // wrong answer ("make these planes parallel").
        var raw = target.value.trim();
        var v = Number(raw);
        if (raw === '' || !isFinite(v)) { target.value = String(DEFAULT_TARGET_DEG); }
        else if (v < 0) { target.value = '0'; }
        else if (v > 90) { target.value = '90'; }
        refresh();
    });
    target.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter' && !apply.disabled) { e.preventDefault(); apply.click(); }
    });

    cancel.addEventListener('click', closeAngleModal);
    apply.addEventListener('click', function () {
        // Re-plan first. The 3D view is interactive while this dialog is open,
        // so a corner may have been dragged since the last input change and
        // `lastPlan` would then describe geometry that no longer exists. The
        // plan is pure, so re-running it costs nothing and closes the gap
        // between what the readout says and what Apply commits.
        refresh();
        var pair = currentPlanes();
        if (!lastPlan || !lastPlan.ok || !pair.fixed || !pair.moving) return;
        var plan = lastPlan;
        closeAngleModal();
        var res = applyAngleEdit(plan, pair.fixed, pair.moving);
        reportAngleEdit(pair.fixed, pair.moving, plan, res);
    });

    document.addEventListener('keydown', onAngleKeyDown, true);
    document.body.appendChild(angleOverlay);
    parkBesideViewport(modal);
    // Freeze the plane data while the dialog is up. `angleOverlay` is set by
    // now, so both of these see `isAngleModalOpen()` and lock: the panel's
    // controls go disabled, and the scene is re-pushed with `editable: false`
    // so a corner cannot be dragged out from under the preview. Orbiting,
    // zooming and selecting are untouched — the view stays live, the DATA does
    // not. See the header note on the edit lock.
    refreshPlanePanel();
    syncPlanes3D();
    refresh();
    target.focus();
    target.select();
}

/** Is the dialog open? For tests and for guards. @returns {boolean} */
export function isAngleModalOpen() {
    return angleOverlay !== null;
}

/** Wire the panel button. Called once from `setupPlaneDefinition`. */
export function setupPlaneAngle() {
    var btn = document.getElementById('btnSetPlaneAngle');
    if (btn) btn.addEventListener('click', showPlaneAngleModal);
    renderAngleButton();
}
