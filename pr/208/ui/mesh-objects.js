// ui/mesh-objects.js — the 3D Mesh Objects table.
//
// A third table under Nodes and Planes, for the third layer of the model:
//
//     node    a point with one 3D position
//     plane   a group of nodes
//     object  a group of PLANES, whose shape comes from how they are connected
//
// Deliberately its OWN module rather than more of `ui/plane-definition.js`.
// That file is already ~3000 lines and owns the mode, the placements, the
// drags, the triangulation calls and two tables; this feature is strictly
// additive and touches none of that, so keeping it separate is what makes the
// "nothing existing changes" claim checkable — `plane-definition.js` gains one
// import and two calls, and that is the whole of its involvement.
//
// ## Everything shown here is DERIVED
//
// The table's Shape column, the report and the member list are recomputed from
// the model on every render. Nothing about the geometry is cached, because the
// underlying 3D can move under us at any moment — a node drag, a re-triangulate,
// a plane fit, an origin change. `buildMeshObjectGeometry` is cheap at this
// scale (dozens of vertices) and being wrong is expensive, so it is called
// fresh.
//
// ## What this module may NOT do
//
// Nothing here creates, deletes or edits a node or a plane. An object is a
// grouping; dissolving the group cannot destroy its members, and un-checking a
// plane must not delete it. The one destructive action on the panel — the
// object's own × — removes the grouping and nothing else. This is the
// constraint that keeps 3D Mesh Objects from being able to break a workflow
// that predates them.

import { planeModel, refreshPlanePanel, syncPlanes3D } from './plane-definition.js';
import { originState } from './origin-definition.js';
import { buildMeshObjectGeometry, connectivitySummary } from '../pose/mesh-object-geometry.js';
import { setStatus, markDirty } from '../import-export/save-load.js';

/**
 * Panel-local selection. Not persisted — which row is open is transient editor
 * state, the same category as `planeState.selectedPlaneId`'s expansion set.
 * @type {{selectedObjectId: number|null}}
 */
export const meshObjectState = {
    selectedObjectId: null,
};

/** The set of objects on the live model. @returns {Object|null} */
function objectSet() {
    var model = planeModel();
    return model ? model.meshObjects : null;
}

/** The selected object, or null. @returns {Object|null} */
export function getSelectedMeshObject() {
    var set = objectSet();
    if (!set || meshObjectState.selectedObjectId == null) return null;
    return set.getObject(meshObjectState.selectedObjectId);
}

/**
 * Geometry for an object, in the frame the user established.
 *
 * The origin frame is applied when one is set, because that is the frame every
 * number the panel reports should be in — a volume quoted in a calibration
 * frame the user has replaced is a number they cannot check. Scale stays 1
 * here; units are an export-time concern and inventing one for the panel would
 * make the reported numbers disagree with the viewport.
 *
 * @param {Object} obj @returns {Object}
 */
export function meshObjectGeometry(obj) {
    return buildMeshObjectGeometry(obj, planeModel(), {
        frame: originState.frame || null,
        scale: 1,
    });
}

// ============================================
// Rendering
// ============================================

/** Re-render the table and the editor. Safe to call with the panel absent. */
export function refreshMeshObjectsPanel() {
    var tbody = document.querySelector('#meshObjectsTable tbody');
    if (!tbody) return;
    renderTable(tbody);
    renderEditor();
}

/** @private */
function renderTable(tbody) {
    tbody.textContent = '';
    var set = objectSet();
    var model = planeModel();
    var objects = set ? set.objects : [];

    var table = document.getElementById('meshObjectsTable');
    var empty = document.getElementById('meshObjectsEmpty');
    if (table) table.style.display = objects.length ? '' : 'none';
    if (empty) empty.style.display = objects.length ? 'none' : '';

    objects.forEach(function (obj) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-mesh-object-id', String(obj.id));
        if (obj.id === meshObjectState.selectedObjectId) tr.classList.add('plane-selected');
        tr.title = 'Click to edit which planes make up "' + obj.name + '"';

        var tdSwatch = document.createElement('td');
        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch';
        swatch.style.background = obj.color;
        tdSwatch.appendChild(swatch);

        var tdName = document.createElement('td');
        tdName.textContent = obj.name;

        var tdCount = document.createElement('td');
        tdCount.className = 'mono';
        var live = obj.planeCount(model);
        tdCount.textContent = String(live);
        // A member plane the user deleted is the one way this count can differ
        // from what they last set, so say so rather than letting the object
        // quietly shrink.
        var dangling = obj.danglingCount(model);
        if (dangling) {
            var mark = document.createElement('span');
            mark.className = 'mesh-object-dangling';
            mark.textContent = '−' + dangling;
            mark.title = dangling + ' member plane(s) no longer exist';
            tdCount.appendChild(mark);
        }

        // ONE build per row: the badge, its tooltip and (for the selected row)
        // the report all read the same connectivity.
        var conn = meshObjectGeometry(obj).connectivity;
        var tdShape = document.createElement('td');
        var summary = connectivitySummary(conn);
        var badge = document.createElement('span');
        badge.className = 'mesh-object-badge mesh-object-badge-' + summary.level;
        badge.textContent = summary.text;
        badge.title = shapeTooltip(conn);
        tdShape.appendChild(badge);

        var tdActions = document.createElement('td');
        tdActions.className = 'plane-actions';
        tdActions.appendChild(makeDeleteButton(
            'Remove the "' + obj.name + '" grouping. Its planes and nodes are NOT deleted.',
            function () { deleteObject(obj); }
        ));

        tr.appendChild(tdSwatch);
        tr.appendChild(tdName);
        tr.appendChild(tdCount);
        tr.appendChild(tdShape);
        tr.appendChild(tdActions);
        tr.addEventListener('click', function () { selectObject(obj.id); });
        tbody.appendChild(tr);
    });
}

/** Long-form connectivity, for the badge's tooltip. @private */
function shapeTooltip(c) {
    var lines = [
        c.faces + ' face(s)',
        c.edgeCount + ' edge(s)',
        c.shells + ' shell(s)',
    ];
    if (c.nakedEdges) lines.push(c.nakedEdges + ' naked edge(s) — the object is open');
    if (c.nonManifoldEdges) lines.push(c.nonManifoldEdges + ' non-manifold edge(s)');
    if (c.isClosed) lines.push('closed; volume ' + c.volume.toFixed(4));
    return lines.join('\n');
}

/** @private */
function renderEditor() {
    var editor = document.getElementById('meshObjectEditor');
    if (!editor) return;
    var obj = getSelectedMeshObject();
    editor.style.display = obj ? '' : 'none';
    if (!obj) return;

    var model = planeModel();

    var nameInput = document.getElementById('meshObjectName');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = obj.name;

    var colorInput = document.getElementById('meshObjectColor');
    if (colorInput) colorInput.value = normalizeHex(obj.color);

    var flip = document.getElementById('meshObjectFlip');
    if (flip) flip.checked = !!obj.flipNormals;

    renderReport(obj);
    renderMembers(obj, model);
}

/**
 * The connectivity read-out.
 *
 * Written to be actionable rather than exhaustive: the counts are there, but
 * what the user needs is the NEXT MOVE, so a naked-edge object says how to close
 * it and a coincident pair names the two nodes to merge. Those hints are the
 * whole point of the report — the raw numbers are diagnosable only by someone
 * who already knows what a naked edge is.
 * @private
 */
function renderReport(obj) {
    var box = document.getElementById('meshObjectReport');
    if (!box) return;
    box.textContent = '';

    var c = meshObjectGeometry(obj).connectivity;
    if (!c.edgeCount) {
        box.appendChild(line('Nothing to build yet — add planes whose nodes are triangulated.', 'warn'));
        return;
    }

    var summary = connectivitySummary(c);
    box.appendChild(line(
        c.faces + ' faces · ' + c.vertices + ' vertices · ' + c.edgeCount + ' edges',
        'info'
    ));

    if (c.isClosed) {
        box.appendChild(line('Closed — volume ' + fmt(c.volume) +
            '. Normals point outward.', 'ok'));
    } else if (c.shells > 1) {
        box.appendChild(line(summary.text + ' — these planes are not all joined. ' +
            'Two planes belong to the same shell only when they SHARE a node.', 'warn'));
    } else {
        box.appendChild(line('Open — ' + c.nakedEdges + ' edge(s) belong to only one face. ' +
            'Fine for a cage with no lid; normals are consistent but which side ' +
            'is "outside" is a guess, so use Flip normals if it looks wrong.', 'warn'));
    }

    if (c.nonManifoldEdges) {
        box.appendChild(line(c.nonManifoldEdges + ' edge(s) are shared by three or more ' +
            'faces. No exporter can orient those consistently.', 'error'));
    }
    if (c.degenerateFaces) {
        box.appendChild(line(c.degenerateFaces + ' plane(s) contributed no face — ' +
            'fewer than 3 of their nodes are triangulated.', 'warn'));
    }
    if (c.stalledFaces) {
        box.appendChild(line(c.stalledFaces + ' face(s) could not be triangulated cleanly ' +
            '(self-intersecting outline).', 'warn'));
    }
    if (c.danglingPlaneIds.length) {
        box.appendChild(line(c.danglingPlaneIds.length +
            ' member plane(s) have been deleted; the object skips them.', 'warn'));
    }

    // The high-value hint: planes drawn to meet whose corners were never joined.
    if (c.coincident.length) {
        var pool = planeModel().pool;
        var names = c.coincident.slice(0, 4).map(function (pair) {
            var a = pool.getNode(pair.a), b = pool.getNode(pair.b);
            return (a ? a.name : pair.a) + ' / ' + (b ? b.name : pair.b);
        }).join(', ');
        box.appendChild(line(c.coincident.length + ' pair(s) of DIFFERENT nodes sit on top ' +
            'of each other (' + names + (c.coincident.length > 4 ? ', …' : '') + '). ' +
            'They look joined but are not — add one node to both planes instead of ' +
            'placing two.', 'warn'));
    }
}

/** @private */
function renderMembers(obj, model) {
    var box = document.getElementById('meshObjectMembers');
    if (!box) return;
    box.textContent = '';

    if (!model.planes.length) {
        box.appendChild(line('No planes in this project yet.', 'info'));
        return;
    }

    model.planes.forEach(function (plane) {
        var row = document.createElement('label');
        row.className = 'mesh-object-member';

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = obj.hasPlane(plane.id);
        cb.addEventListener('change', function () {
            var changed = cb.checked ? obj.addPlane(plane.id) : obj.removePlane(plane.id);
            if (changed) {
                markDirty();
                notifyViewport();
            }
        });

        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch';
        swatch.style.background = plane.color;

        var label = document.createElement('span');
        label.textContent = plane.name;

        var count = document.createElement('span');
        count.className = 'mesh-object-member-count';
        count.textContent = plane.nodeIds.length + ' nodes';

        row.appendChild(cb);
        row.appendChild(swatch);
        row.appendChild(label);
        row.appendChild(count);
        box.appendChild(row);
    });
}

/** @private */
function line(text, level) {
    var div = document.createElement('div');
    div.className = 'mesh-object-line mesh-object-line-' + (level || 'info');
    div.textContent = text;
    return div;
}

/** @private */
function fmt(v) {
    if (!isFinite(v)) return '—';
    var a = Math.abs(v);
    return (a >= 1000 || (a > 0 && a < 0.001)) ? v.toExponential(3) : v.toFixed(4);
}

/**
 * `<input type="color">` refuses anything but `#rrggbb`, and silently falls
 * back to black rather than erroring. @private
 */
function normalizeHex(color) {
    if (typeof color !== 'string') return '#26a69a';
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
    if (!m) return '#26a69a';
    if (m[1].length === 3) {
        return '#' + m[1][0] + m[1][0] + m[1][1] + m[1][1] + m[1][2] + m[1][2];
    }
    return '#' + m[1];
}

/** @private */
function makeDeleteButton(title, onClick) {
    var btn = document.createElement('button');
    btn.textContent = '×';
    btn.className = 'panel-btn';
    btn.style.cssText = 'padding:0 5px;font-size:14px;line-height:1;min-width:0;color:var(--error-color);';
    btn.title = title;
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        onClick();
    });
    return btn;
}

// ============================================
// Actions
// ============================================

/** @private */
function selectObject(id) {
    meshObjectState.selectedObjectId =
        (meshObjectState.selectedObjectId === id) ? null : id;
    notifyViewport();
}

/** Create an object, select it, and mark the project dirty. */
export function createMeshObject(name) {
    var set = objectSet();
    if (!set) return null;
    var obj = set.createObject(name);
    meshObjectState.selectedObjectId = obj.id;
    markDirty();
    notifyViewport();
    return obj;
}

/**
 * Remove a grouping. The member planes and their nodes are untouched — see the
 * module note; this is the whole of this panel's destructive surface.
 */
export function deleteObject(obj) {
    var set = objectSet();
    if (!set || !obj) return false;
    if (!set.deleteObject(obj)) return false;
    if (meshObjectState.selectedObjectId === obj.id) meshObjectState.selectedObjectId = null;
    markDirty();
    setStatus('Removed 3D mesh object "' + obj.name + '" (its planes were kept)', 'info');
    notifyViewport();
    return true;
}

/**
 * Re-render the panel and the 3D scene after an object changed.
 *
 * Both, because the two answer different questions and an object edit moves
 * both: `refreshPlanePanel` redraws this table (it calls
 * `refreshMeshObjectsPanel`), and `syncPlanes3D` is the single function every
 * plane mutation already routes through to push the model into the viewport —
 * reaching for `viewport3d` directly here would be a second path to keep in
 * step with it.
 * @private
 */
function notifyViewport() {
    refreshPlanePanel();
    syncPlanes3D();
}

// ============================================
// Wiring
// ============================================

/** Wire the table's controls. Called once, from `setupPlaneDefinition`. */
export function setupMeshObjects() {
    var newBtn = document.getElementById('btnNewMeshObject');
    if (newBtn) {
        newBtn.addEventListener('click', function () { createMeshObject(); });
    }

    var nameInput = document.getElementById('meshObjectName');
    if (nameInput) {
        // `input` renames live so the table tracks typing; `change` is what
        // marks the project dirty, so holding a key down is one edit, not fifty.
        nameInput.addEventListener('input', function () {
            var obj = getSelectedMeshObject();
            var set = objectSet();
            if (obj && set) {
                set.renameObject(obj, nameInput.value);
                refreshMeshObjectsPanel();
            }
        });
        nameInput.addEventListener('change', function () {
            var obj = getSelectedMeshObject();
            var set = objectSet();
            if (obj && set && set.renameObject(obj, nameInput.value)) {
                refreshMeshObjectsPanel();
            }
            markDirty();
        });
    }

    var colorInput = document.getElementById('meshObjectColor');
    if (colorInput) {
        colorInput.addEventListener('input', function () {
            var obj = getSelectedMeshObject();
            var set = objectSet();
            if (obj && set) {
                set.recolorObject(obj, colorInput.value);
                notifyViewport();
            }
        });
        colorInput.addEventListener('change', function () { markDirty(); });
    }

    var flip = document.getElementById('meshObjectFlip');
    if (flip) {
        flip.addEventListener('change', function () {
            var obj = getSelectedMeshObject();
            if (!obj) return;
            obj.flipNormals = flip.checked;
            markDirty();
            notifyViewport();
        });
    }
}
