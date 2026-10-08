// ui/plane-list-panel.js — the ROSTER half of the panel's Planes section: the
// Planes table, its action row, the `Views: annotated / total` fraction and the
// per-plane placements sub-row. The table is also the DRAG SOURCE that places a
// plane onto a video view, and the one control that SELECTS which plane the
// editor below it edits (`ui/plane-editor-panel.js`, same <details>).
//
// Split out of `ui/plane-definition.js`. Cohesive by what it renders, not by
// size: everything here draws or wires one Planes row, and nothing here solves
// anything — Triangulate and Fit are reported through the hub's
// `triangulatePlaneAndReport` / `fitPlaneAndReport`.
//
// `annotatedViewStats` counts HAND-PLACED views only, never reprojected ones —
// see its own comment and `tests/e2e/plane-views-column.mjs`. That rule is the
// reason this fraction exists, so it travels with the function.
//
// Everything imported from `./plane-definition.js` is circular and read inside
// a function body only, never at this module's top level. Same rule as
// `ui/plane-nodes-panel.js`; see the note there.

import { state, interactionManager } from './app-state.js?v=52890dc262e0';
import { getPoint3d, hasPoint3d } from '../pose/pose-data.js?v=52890dc262e0';
import {
    planeNodeIndices, points3dForPlane, nodeErrorsForPlane,
} from '../pose/plane-data.js?v=52890dc262e0';
import { fittedPlanes } from './origin-definition.js?v=52890dc262e0';
import {
    ICON_PIN, PLANE_DRAG_MIME, makeDeleteButton, setEmptyState, redraw,
    planeModel, planeState, getSelectedPlane, deletePlane, placedViewsOf,
    planeImmutableMask, unplacePlaneFromView, refreshPlanePanel,
} from './plane-definition.js?v=52890dc262e0';

// --- Planes table (drag source) --------------------------------------------

// Inline SVG icons. Drawn rather than taken from a font so the triangulate and
// fill actions read as what they do at 12 px.
export const ICON_TRIANGULATE =
    '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">' +
    '<polygon points="7,2 12.5,11.5 1.5,11.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<circle cx="7" cy="2" r="1.5" fill="currentColor"/>' +
    '<circle cx="12.5" cy="11.5" r="1.5" fill="currentColor"/>' +
    '<circle cx="1.5" cy="11.5" r="1.5" fill="currentColor"/></svg>';
export const ICON_MESH =
    '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">' +
    '<polygon points="2,2 12,3.5 11,12 3,10.5" fill="currentColor" fill-opacity="0.45" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<line x1="2" y1="2" x2="11" y2="12" stroke="currentColor" stroke-width="1"/></svg>';
// Scattered points collapsing onto a line — a plane seen edge-on.
export const ICON_FIT =
    '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">' +
    '<line x1="1.5" y1="9.5" x2="12.5" y2="4.5" stroke="currentColor" stroke-width="1.4"/>' +
    '<circle cx="3.5" cy="7.2" r="1.3" fill="currentColor"/>' +
    '<circle cx="7" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="10.5" cy="4.2" r="1.3" fill="currentColor"/></svg>';

/**
 * Enable/disable + relabel the shared Triangulate / Fill / Fit row.
 *
 * All three act on the SELECTED plane, so they are disabled outright when
 * nothing is selected. When something IS selected they stay enabled even if the
 * action's precondition fails (too few views, too few nodes) — clicking then
 * reports WHY in the status bar, which teaches more than a dead button.
 */
export function renderActionRow() {
    var plane = getSelectedPlane();
    var triBtn = document.getElementById('btnPlaneTriangulate');
    var fillBtn = document.getElementById('btnPlaneFill');
    var fitBtn = document.getElementById('btnPlaneFit');
    if (!triBtn || !fillBtn || !fitBtn) return;

    [triBtn, fillBtn, fitBtn].forEach(function (b) { b.disabled = !plane; });
    if (!plane) {
        triBtn.title = fillBtn.title = fitBtn.title = 'Select a plane first';
        triBtn.classList.remove('active');
        fillBtn.classList.remove('active');
        fitBtn.classList.remove('active');
        fillBtn.style.color = '';
        return;
    }

    var nPlaced = placedViewsOf(plane).length;

    triBtn.classList.toggle('active', !!plane.triangulation);
    triBtn.title = plane.triangulation
        ? 'Re-triangulate "' + plane.name + '" (currently ' + plane.triangulation.nNodes +
          ' node(s) from ' + plane.triangulation.views.join(', ') + ')'
        : 'Triangulate "' + plane.name + '" across the ' + nPlaced +
          ' view(s) it is placed on, and show it in the 3D viewer';

    fillBtn.classList.toggle('active', !!plane.filled);
    fillBtn.style.color = plane.filled ? plane.color : '';
    fillBtn.title = (plane.filled ? 'Unfill' : 'Fill') + ' the "' + plane.name +
        '" polygon with its colour';

    var nPinned = planeImmutableMask(plane).filter(Boolean).length;
    fitBtn.classList.toggle('active', !!plane.planeFit);
    fitBtn.title = 'Fit a plane of best fit to "' + plane.name + '" and flatten its ' +
        'points onto it, updating the 3D viewer and every 2D view' +
        (nPinned ? ' — constrained to pass through its ' + nPinned + ' pinned node(s)' : '') +
        (plane.planeFit ? ' (last fit moved points ' + plane.planeFit.rms.toFixed(2) +
            ' mm RMS)' : '');
}

/**
 * Set Origin needs a FITTED plane, not a selected one — the wizard picks its
 * corner in the 3D scene, from any fitted plane, so gating it on the panel
 * selection would disable it for a perfectly valid project.
 */
export function renderOriginButton() {
    var btn = document.getElementById('btnSetOrigin');
    if (!btn) return;
    var nFit = fittedPlanes().length;
    btn.disabled = nFit === 0;
    btn.title = nFit === 0
        ? 'Fit a plane first — Set Origin picks a node of a fitted plane'
        : 'Re-define the 3D origin from any node of one of the ' + nFit +
          ' fitted plane(s)';
}

/**
 * How many views this plane has been ANNOTATED on, out of every view in the
 * session.
 *
 * "Annotated" and "placed" are different questions, and the gap between them is
 * the whole reason this column exists: `Triangulate` reprojects a plane into the
 * views it was never placed on, so afterwards it IS placed everywhere while the
 * user may only ever have drawn it twice. A corner the solve put there is the
 * model's own output — it carries no new information and is excluded from the
 * next solve — so counting it would turn this into a number that always reads
 * full and never says anything.
 *
 * A view counts when at least one of the plane's corners there is hand-placed:
 * present, not switched off, and not reprojected. That is the SAME test
 * `triangulatePlane` applies to decide which views may contribute (`usableViews`
 * there), so the fraction and the solver cannot disagree about what counts.
 *
 * A shared node hand-placed for a neighbouring plane counts for this one too,
 * deliberately: one node is one 2D point per view, so the evidence is genuinely
 * there for both.
 *
 * @param {PlaneSkeleton} plane
 * @returns {{annotated:number, total:number}} `total` is 0 with no calibration
 *   loaded, which the caller renders as a dash rather than "0/0".
 * @private
 */
function annotatedViewStats(plane) {
    var session = state.session;
    var cams = (session && session.cameras) ? session.cameras : [];
    if (!cams.length) return { annotated: 0, total: 0 };

    var model = planeModel();
    var poolIdx = planeNodeIndices(plane, model.pool);
    var annotated = 0;
    for (var c = 0; c < cams.length; c++) {
        var name = cams[c].name;
        if (!model.isPlanePlaced(plane, name)) continue;
        var inst = model.getInstance(name);
        if (!inst) continue;
        for (var k = 0; k < poolIdx.length; k++) {
            var pi = poolIdx[k];
            if (pi >= 0 && inst.hasPoint(pi) &&
                !inst.isNodeNulled(pi) && !inst.isNodeDerived(pi)) { annotated++; break; }
        }
    }
    return { annotated: annotated, total: cams.length };
}

export function renderPlanesTable() {
    var tbody = document.querySelector('#planeSkeletonsTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var model = planeModel();
    var pool = model.pool;
    setEmptyState('planeSkeletonsTable', 'planeSkeletonsEmpty', model.planes.length === 0);

    model.planes.forEach(function (plane) {
        var views = model.placedViews(plane);
        var tr = document.createElement('tr');
        tr.setAttribute('data-plane-skeleton-id', String(plane.id));
        if (plane.id === planeState.selectedPlaneId) tr.classList.add('plane-selected');

        // A plane with no nodes has nothing to draw, so make it undraggable
        // rather than letting a drop produce an invisible placement.
        var draggable = plane.nodeIds.length > 0;
        tr.draggable = draggable;
        tr.title = draggable
            ? 'Drag onto a video view to place; click to edit'
            : 'Add at least one node before placing this plane';

        // --- Expander: reveals where this plane is placed ---
        var expanded = planeState.expanded.has(plane.id);
        var tdExpand = document.createElement('td');
        var expandBtn = document.createElement('button');
        expandBtn.className = 'plane-expander' + (expanded ? ' open' : '');
        // Caret only. It used to carry the placed-view count as a bare number
        // beside it, which sat one column away from the Views fraction and was
        // a DIFFERENT number (placed, not annotated) with nothing to say so —
        // two unlabelled view counts per row is one too many. The placements
        // themselves are still listed by expanding the row.
        expandBtn.innerHTML = '<span class="plane-caret">▶</span>';
        expandBtn.title = views.length
            ? (expanded ? 'Hide placements' : 'Show the ' + views.length + ' placement(s)')
            : 'Not placed on any view yet';
        expandBtn.disabled = views.length === 0;
        expandBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (planeState.expanded.has(plane.id)) planeState.expanded.delete(plane.id);
            else planeState.expanded.add(plane.id);
            refreshPlanePanel();
        });
        tdExpand.appendChild(expandBtn);

        var tdName = document.createElement('td');
        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch';
        swatch.style.background = plane.color;
        tdName.appendChild(swatch);
        tdName.appendChild(document.createTextNode(plane.name));
        // The column is fixed-width now, so a long name ellipses. Repeat it
        // here — a cell title wins over the row's, so the row's drag hint has
        // to come along or it would be lost exactly on the name.
        tdName.title = plane.name + '\n' + tr.title;

        var tdNodes = document.createElement('td');
        tdNodes.className = 'mono';
        tdNodes.textContent = String(plane.nodeIds.length);
        // Shared nodes are the reason the pool exists — say how many, here,
        // where the user is choosing which plane to work on.
        var nShared = plane.nodeIds.filter(function (id) {
            return model.planesForNode(id).length > 1;
        }).length;
        // No `+N` badge. It meant "of which N are shared", but `+` reads as an
        // ADDITION — `4 +4` looked like 9 on a plane that has four corners. The
        // count stays in the cell's tooltip, where it can use words.
        tdNodes.title = nShared
            ? plane.nodeIds.length + ' nodes, ' + nShared +
                ' of them shared with another plane'
            : plane.nodeIds.length + ' nodes, none shared with another plane';

        // --- Views: annotated / total, the progress of the 2D work ---
        var stats = annotatedViewStats(plane);
        var tdViews = document.createElement('td');
        tdViews.className = 'mono';
        tdViews.textContent = stats.total
            ? stats.annotated + '/' + stats.total
            : '—';
        tdViews.title = stats.total
            ? 'Hand-annotated on ' + stats.annotated + ' of ' + stats.total +
                ' view(s). Corners the solve reprojected do not count.'
            : 'No calibration loaded, so there are no views yet';

        // --- Actions: delete only. Triangulate / Fill / Fit are in the shared
        // action row below the table, where they act on the SELECTED plane
        // rather than being repeated on every row.
        var tdActions = document.createElement('td');
        tdActions.className = 'plane-actions';

        // NO `3D` badge. Two letters in a box, in a column with no header, are
        // not a word — and whether a plane has been solved is answerable from
        // the panel in several better places (its 3D in the viewport, the node
        // coordinates, the triangulation summary when it is selected).

        tdActions.appendChild(makeDeleteButton(
            'Delete this plane (nodes another plane also uses are kept)', function () {
                deletePlane(plane.id);
                refreshPlanePanel();
                redraw();
            }));

        // The row is the drag handle, so the browser would start a drag from a
        // button press too. Suspending `draggable` while the cursor is over the
        // controls keeps them clickable without giving up row-wide dragging.
        [tdExpand, tdActions].forEach(function (cell) {
            cell.addEventListener('mouseenter', function () { tr.draggable = false; });
            cell.addEventListener('mouseleave', function () { tr.draggable = draggable; });
        });

        tr.addEventListener('click', function () {
            planeState.selectedPlaneId = plane.id;
            refreshPlanePanel();
        });

        tr.addEventListener('dragstart', function (e) {
            if (!draggable) { e.preventDefault(); return; }
            // Private MIME only — see the module note: a `text/plain` payload
            // would be grabbed by dockview's video-panel drop handler.
            e.dataTransfer.setData(PLANE_DRAG_MIME, String(plane.id));
            e.dataTransfer.effectAllowed = 'copy';
        });

        tr.appendChild(tdExpand);
        tr.appendChild(tdName);
        tr.appendChild(tdNodes);
        tr.appendChild(tdViews);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);

        if (expanded && views.length) {
            tbody.appendChild(buildPlacementsRow(plane, views, pool));
        }
    });
}

/**
 * The expanded sub-row for a plane: one line per view it is placed on
 * (click to select, × to un-place), plus the triangulation readout when there
 * is one — a Triangulate button whose result you cannot see would be a dead end.
 */
function buildPlacementsRow(plane, views, pool) {
    var model = planeModel();
    var tr = document.createElement('tr');
    tr.className = 'plane-placements-row';
    tr.setAttribute('data-plane-placements-for', String(plane.id));

    var td = document.createElement('td');
    td.colSpan = 4;
    // Everything goes inside a body div indented under its plane row, the same
    // shape `renderNodeDetailRow` uses — and, more importantly, the only place
    // the cell's inherited `white-space: nowrap` (from `.data-table tbody td`)
    // can be undone. That inheritance is what used to push the summary lines
    // past the panel's right edge and give the whole panel a horizontal scroll.
    var body = document.createElement('div');
    body.className = 'plane-placements-body';
    td.appendChild(body);

    var selected = interactionManager ? interactionManager.selectedPlane : null;
    var poolIdx = planeNodeIndices(plane, pool);

    views.forEach(function (viewName) {
        var inst = model.getInstance(viewName);
        var row = document.createElement('div');
        row.className = 'plane-placement-item';
        row.setAttribute('data-plane-view', viewName);
        if (inst && inst === selected) row.classList.add('plane-selected');

        var name = document.createElement('span');
        name.className = 'plane-placement-view';
        name.textContent = viewName;
        row.appendChild(name);

        var off = 0, derived = 0;
        for (var i = 0; i < poolIdx.length; i++) {
            if (poolIdx[i] < 0 || !inst) continue;
            if (inst.isNodeNulled(poolIdx[i])) off++;
            else if (inst.isNodeDerived(poolIdx[i])) derived++;
        }
        var meta = document.createElement('span');
        meta.className = 'plane-placement-meta';
        // A view the plane was REPROJECTED onto is placed like any other, so
        // without this the list gives no clue that its corners are the model's
        // output rather than the user's annotation — and that they do not count
        // as evidence in the next solve.
        var bits = [];
        if (off) bits.push(off + ' off');
        if (derived) bits.push(derived + ' reprojected');
        meta.textContent = bits.join(', ');
        if (derived) {
            meta.title = derived + ' corner(s) here were reprojected from the 3D, ' +
                'not annotated on this view — drag one to make it count as an ' +
                'observation in the next triangulation';
        }
        row.appendChild(meta);

        var del = makeDeleteButton(
            'Un-place "' + plane.name + '" from ' + viewName +
            ' (its 2D points are kept, so re-placing restores them)',
            function () {
                unplacePlaneFromView(plane, viewName);
                refreshPlanePanel();
                redraw();
            });
        row.appendChild(del);

        row.addEventListener('click', function () {
            if (interactionManager && inst) interactionManager.selectPlane(inst, -1);
            refreshPlanePanel();
            redraw();
        });
        body.appendChild(row);
    });

    if (plane.triangulation) {
        var t = plane.triangulation;
        var summary = document.createElement('div');
        summary.className = 'plane-tri-summary';
        summary.textContent = '3D: ' + t.nNodes + '/' + plane.nodeIds.length +
            ' nodes from ' + t.views.join(', ') +
            (t.meanError != null ? ' — mean err ' + t.meanError.toFixed(2) + ' px' : '');
        // These lines WRAP now rather than running off the edge, so the whole
        // sentence is on screen; the title is kept for a view list long enough
        // to still be worth reading in one piece.
        summary.title = summary.textContent;
        body.appendChild(summary);

        if (t.nAnchors) {
            var anchors = document.createElement('div');
            anchors.className = 'plane-tri-summary plane-anchor-summary';
            // A pinned node's residual is OUT of sample — no degree of freedom
            // was spent fitting it — so it is reported apart from the solve's
            // own error rather than diluting it.
            anchors.textContent = t.nAnchors + ' pinned node(s) held fixed' +
                (t.anchorMeanError != null
                    ? ' — they reproject ' + t.anchorMeanError.toFixed(2) + ' px off'
                    : '');
            anchors.title = anchors.textContent;
            body.appendChild(anchors);
        }

        if (plane.planeFit) {
            var f = plane.planeFit;
            var fit = document.createElement('div');
            fit.className = 'plane-tri-summary plane-fit-summary';
            fit.textContent = (f.constrained ? 'Fitted (constrained) — normal (' : 'Fitted plane — normal (') +
                f.normal.map(function (q) { return q.toFixed(3); }).join(', ') +
                '), was ' + f.rms.toFixed(2) + ' mm RMS off-plane';
            fit.title = fit.textContent + '\nCentroid (' +
                f.centroid.map(function (q) { return q.toFixed(1); }).join(', ') + ')';
            body.appendChild(fit);
        }

        var points3d = points3dForPlane(plane, pool);
        var errors = nodeErrorsForPlane(plane, pool);
        for (var n = 0; n < plane.nodeIds.length; n++) {
            var node = pool.getNode(plane.nodeIds[n]);
            var nodeName = node ? node.name : '?';
            var line = document.createElement('div');
            line.className = 'plane-tri-node';
            line.setAttribute('data-plane-node-id', String(plane.nodeIds[n]));
            var sw = document.createElement('span');
            sw.className = 'plane-swatch';
            sw.style.background = node ? node.color : '#888';
            line.appendChild(sw);

            // One flex row per node, in parts rather than as one string, so it
            // can WRAP at the panel's width instead of running off it — and so
            // the name is the only piece that ever ellipses. The whole line is
            // repeated in the tooltip either way.
            var nameEl = document.createElement('span');
            nameEl.className = 'plane-tri-node-name';
            nameEl.textContent = nodeName;
            line.appendChild(nameEl);

            var full = nodeName;
            var xyzEl = document.createElement('span');
            xyzEl.className = 'plane-tri-node-xyz';
            if (hasPoint3d(points3d, n)) {
                var q = getPoint3d(points3d, n);
                xyzEl.textContent = '(' + q[0].toFixed(1) + ', ' + q[1].toFixed(1) +
                    ', ' + q[2].toFixed(1) + ')';
                full += '  ' + xyzEl.textContent;
                line.appendChild(xyzEl);
                if (errors[n] != null) {
                    var errEl = document.createElement('span');
                    errEl.className = 'plane-tri-node-err';
                    errEl.textContent = errors[n].toFixed(2) + ' px';
                    line.appendChild(errEl);
                    full += '  ' + errEl.textContent + ' reprojection error';
                }
            } else {
                xyzEl.textContent = '—';
                full += '  — (no 3D yet)';
                line.appendChild(xyzEl);
            }
            if (node && node.immutable) {
                // The padlock the Nodes list already uses, in place of the word
                // "pinned": eight characters is a third of the width a
                // coordinate needs, and the word is still in the tooltip.
                var pinEl = document.createElement('span');
                pinEl.className = 'plane-tri-node-pin';
                pinEl.innerHTML = ICON_PIN.locked;
                line.appendChild(pinEl);
                full += '  — pinned (Locked)';
            }
            line.title = full;
            body.appendChild(line);
        }
    }

    tr.appendChild(td);
    return tr;
}
