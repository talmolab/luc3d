// ui/plane-editor-panel.js — the EDITOR half of the panel's Planes section:
// the name field, the member list, the "+ Add" existing-node picker and the
// edge pickers, for whichever plane is selected.
//
// It does NOT choose the plane. A plane is picked by clicking its row in the
// roster directly above (`ui/plane-list-panel.js`), which is the only writer of
// `planeState.selectedPlaneId` besides `createPlane`, and created with the
// `+ New Plane` button between the two — the same shape as 3D Mesh Objects,
// where the table selects and one `+ New` button creates. A `<select>` here
// used to duplicate the table's job, which cost it a disabled
// "— select a plane —" placeholder and a pinned "+ New Plane" action sitting
// among the planes as if it were one.
//
// The roster and this editor are ONE section in the markup (`#planePlanesDetails`)
// and two modules here, which is the split that matches how they change: the
// roster renders every plane, this renders the selected one. They were two
// sections as well, "Edit Plane" above "Planes", until the reader having to
// scroll between the list and the controls made the case for merging them.
//
// Split out of `ui/plane-definition.js` alongside `ui/plane-nodes-panel.js`
// (the Nodes pool) and `ui/plane-list-panel.js` (the roster), so the panel's
// parts are modules and the hub keeps only the orchestration that drives them.
//
// `renderEditor` is the section's entry point and is what the hub's
// `refreshPlanePanel` calls. It also calls into the Nodes section
// (`renderNodesTable` / `renderFrozenWarning`), which is a one-directional
// import: that module never calls back into this one.
//
// Everything imported from `./plane-definition.js` is circular and read inside
// a function body only, never at this module's top level. Same rule as the
// other two sections; see the note in `ui/plane-nodes-panel.js`.

import { markDirty } from '../import-export/save-load.js?v=43d71547d3e1';
import { renderNodesTable, renderFrozenWarning } from './plane-nodes-panel.js?v=43d71547d3e1';
import {
    makeDeleteButton, setEmptyState, redraw, planeModel, planePool,
    getSelectedPlane, refreshPlanePanel, syncPlanes3D,
} from './plane-definition.js?v=43d71547d3e1';

/**
 * The editor: what the SELECTED plane is made of (its name, which nodes are in
 * it, and its connections), rendered under the roster that picked it.
 *
 * The body is empty-stated as a whole rather than shown half-dead, because
 * every control in it needs a plane to act on: a name field with nothing to
 * name and an "add node" dropdown with nowhere to add to are worse than an
 * explanation. The roster, `+ New Plane` and Plane Appearance all sit OUTSIDE
 * the swapped body and stay live either way — with no planes at all `+ New
 * Plane` is the only thing in the section that can do anything, so
 * empty-stating it too would make this a dead end.
 */
export function renderEditor() {
    var plane = getSelectedPlane();

    // Name the plane in the section header, so a reader who has scrolled the
    // roster out of view still knows WHICH plane the controls below belong to —
    // and so a folded section says it without being opened.
    var title = document.getElementById('planeEditorTitle');
    if (title) title.textContent = plane ? plane.name : '— none selected';

    var body = document.getElementById('planeEditorContent');
    var empty = document.getElementById('planeEditorEmpty');
    if (body) body.style.display = plane ? '' : 'none';
    if (empty) empty.style.display = plane ? 'none' : '';

    var nameInput = document.getElementById('planeSkeletonName');
    if (nameInput) {
        nameInput.value = plane ? plane.name : '';
        nameInput.disabled = !plane;
    }

    renderNodesTable();
    renderFrozenWarning();
    renderPlaneMembers(plane);
    renderAddNodeSelect(plane);
    renderEdgeSelects(plane);
    renderEditorEdges(plane);
}

/**
 * The members table: the nodes IN the selected plane, in the plane's own
 * order.
 *
 * The × here is a REFERENCE removal — `removeNodeFromPlane` with
 * `deleteIfOrphan:false`, so the node stays in the pool with its 3D, its pin
 * and its 2D on every view even if this was the last plane using it. Destroying
 * a node is the Nodes table's × and asks first; keeping the two apart is what stops
 * "take this corner out of this wall" from silently meaning "throw the corner
 * away".
 *
 * The colour is a read-only swatch rather than a second picker: colour is a
 * property of the NODE, so it is edited in one place (the Nodes table) and shown
 * here only as the cross-view correspondence cue it is.
 */
function renderPlaneMembers(plane) {
    var tbody = document.querySelector('#planeMembersTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var ids = plane ? plane.nodeIds : [];
    setEmptyState('planeMembersTable', 'planeMembersEmpty', ids.length === 0);
    if (!plane) return;

    var model = planeModel();
    var pool = model.pool;
    ids.forEach(function (id) {
        var node = pool.getNode(id);
        if (!node) return;
        var tr = document.createElement('tr');
        tr.setAttribute('data-plane-member-id', String(id));
        var usedBy = model.planesForNode(id);
        // Same marker as the pool table, so a corner shared with another plane
        // reads the same wherever the user meets it.
        if (usedBy.length > 1) tr.className = 'plane-node-row plane-node-shared';

        var tdName = document.createElement('td');
        tdName.className = 'plane-member-name';
        tdName.textContent = node.name;
        tdName.title = usedBy.length > 1
            ? '"' + node.name + '" is shared with ' +
              usedBy.filter(function (p) { return p.id !== plane.id; })
                  .map(function (p) { return p.name; }).join(', ')
            : 'Only "' + plane.name + '" uses this node';

        var tdColor = document.createElement('td');
        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch plane-member-swatch';
        swatch.style.background = node.color;
        swatch.title = 'Colour is a property of the node — change it in the Nodes table';
        tdColor.appendChild(swatch);

        var tdDel = document.createElement('td');
        tdDel.appendChild(makeDeleteButton(
            'Take "' + node.name + '" out of plane "' + plane.name +
            '" only. The node stays in the project' +
            (usedBy.length > 1 ? ' and in the other plane(s) using it' : '') +
            ' — delete it in the Nodes table if you want it gone.',
            function () {
                model.removeNodeFromPlane(plane, id, { deleteIfOrphan: false });
                markDirty();
                syncPlanes3D();
                refreshPlanePanel();
                redraw();
            }));

        tr.appendChild(tdName);
        tr.appendChild(tdColor);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });
}

/**
 * Fill the "add an existing node" dropdown with every POOL node that is not
 * already in the selected plane.
 *
 * This is the headline affordance of the whole model: adding the SAME node to a
 * second plane is how two planes come to meet along a shared line, so it is a
 * visible control with its own button rather than a checkbox buried in a row.
 * An empty list is a real state (every node is already in this plane), and it
 * is stated in words instead of leaving a dead dropdown.
 */
function renderAddNodeSelect(plane) {
    var select = document.getElementById('planeAddNodeSelect');
    var btn = document.getElementById('btnAddExistingPlaneNode');
    var hint = document.getElementById('planeAddNodeHint');
    if (select) select.textContent = '';

    var model = planeModel();
    var pool = model.pool;
    var candidates = plane
        ? pool.nodes.filter(function (n) { return !plane.hasNode(n.id); })
        : [];

    if (select) {
        // Values are NODE IDS — names are user-editable and can collide, and
        // pool indices shift under a delete.
        candidates.forEach(function (node) {
            var opt = document.createElement('option');
            opt.value = String(node.id);
            var used = model.planesForNode(node.id);
            opt.textContent = node.name +
                (used.length ? '  (in ' + used.map(function (p) { return p.name; }).join(', ') + ')' : '');
            select.appendChild(opt);
        });
        select.disabled = candidates.length === 0;
    }
    if (btn) btn.disabled = !plane || candidates.length === 0;
    if (hint) {
        if (!plane) hint.textContent = '';
        else if (pool.size === 0) {
            hint.textContent = 'No nodes exist yet — create one with + Node above.';
        } else if (candidates.length === 0) {
            hint.textContent = 'Every node in the project is already in "' + plane.name +
                '". Create a new one with + Node above.';
        } else {
            // Nothing in the ordinary case. The two branches above are real
            // dead ends — the dropdown is empty and says why — whereas with
            // candidates in it the control explains itself, and a standing
            // paragraph under a working picker is just a paragraph.
            hint.textContent = '';
        }
    }
}

/** Fill the two connection dropdowns from the SELECTED plane's nodes. @private */
function renderEdgeSelects(plane) {
    var srcSelect = document.getElementById('planeEdgeSrcSelect');
    var dstSelect = document.getElementById('planeEdgeDstSelect');
    if (srcSelect) srcSelect.textContent = '';
    if (dstSelect) dstSelect.textContent = '';
    if (!plane) return;
    var pool = planePool();
    // Values are NODE IDS, not indices: an edge is stored as an id pair so it
    // cannot silently re-point at a neighbour when the pool or the plane's own
    // order changes, and the option value has to speak the same language.
    plane.nodeIds.forEach(function (id) {
        var node = pool.getNode(id);
        if (!node) return;
        if (srcSelect) {
            var o1 = document.createElement('option');
            o1.value = String(id);
            o1.textContent = node.name;
            srcSelect.appendChild(o1);
        }
        if (dstSelect) {
            var o2 = document.createElement('option');
            o2.value = String(id);
            o2.textContent = node.name;
            dstSelect.appendChild(o2);
        }
    });
    // Default the destination to the second node so the common
    // "connect the next one" case is one click.
    if (dstSelect && plane.nodeIds.length > 1) dstSelect.value = String(plane.nodeIds[1]);
}

function renderEditorEdges(plane) {
    var tbody = document.querySelector('#planeEdgesTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var edges = plane ? plane.edges : [];
    setEmptyState('planeEdgesTable', 'planeEdgesEmpty', edges.length === 0);
    if (!plane) return;
    var pool = planePool();

    edges.forEach(function (edge, edgeIdx) {
        var tr = document.createElement('tr');
        var src = pool.getNode(edge[0]);
        var dst = pool.getNode(edge[1]);

        var tdSrc = document.createElement('td');
        tdSrc.textContent = src ? src.name : '?';
        var tdDst = document.createElement('td');
        tdDst.textContent = dst ? dst.name : '?';

        var tdDel = document.createElement('td');
        tdDel.appendChild(makeDeleteButton('Remove connection', function () {
            plane.removeEdge(edgeIdx);
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        }));

        tr.appendChild(tdSrc);
        tr.appendChild(tdDst);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });
}
