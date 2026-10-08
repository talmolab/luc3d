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
// The report and the member list are recomputed from the model on every render. Nothing about the geometry is cached, because the
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

import { planeModel, refreshPlanePanel, syncPlanes3D } from './plane-definition.js?v=41ee6ff3be65';
import { originState } from './origin-definition.js?v=41ee6ff3be65';
import { buildMeshObjectGeometry, connectivitySummary } from '../pose/mesh-object-geometry.js?v=41ee6ff3be65';
import { setStatus, markDirty } from '../import-export/save-load.js?v=41ee6ff3be65';
import {
    meshObjectToSTL, meshObjectToGLB, isExportable, meshFilenameStem,
} from '../import-export/mesh-export.js?v=41ee6ff3be65';
import { downloadBytes } from '../import-export/file-io.js?v=41ee6ff3be65';

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

        // NO Shape column. It carried a `open — 6 naked` badge, and "naked
        // edge" is a term the panel never defined — a verdict in jargon is not a
        // verdict. What is ACTIONABLE about connectivity (planes that are not
        // joined, corners that only look joined, non-manifold edges) is in the
        // selected object's report, in words. A side effect worth having: the
        // table no longer derives every object's full geometry on every repaint
        // just to print one word.
        var tdActions = document.createElement('td');
        tdActions.className = 'plane-actions';
        tdActions.appendChild(makeDeleteButton(
            'Remove the "' + obj.name + '" grouping. Its planes and nodes are NOT deleted.',
            function () { deleteObject(obj); }
        ));

        tr.appendChild(tdSwatch);
        tr.appendChild(tdName);
        tr.appendChild(tdCount);
        tr.appendChild(tdActions);
        tr.addEventListener('click', function () { selectObject(obj.id); });
        tbody.appendChild(tr);
    });
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

    renderReport(obj);
    renderMembers(obj, model);
    renderAddPlaneSelect(obj, model);
    renderExportButtons(obj);
}

/**
 * Enable the two export buttons only when there is a shape to write.
 *
 * An object whose planes are not triangulated yet has no triangles, so both
 * writers would refuse. Saying so on the button — greyed out, with the reason
 * in the tooltip — beats letting the click land and reporting a failure the
 * user could have been shown in advance.
 * @private
 */
function renderExportButtons(obj) {
    var stl = document.getElementById('btnExportMeshStl');
    var glb = document.getElementById('btnExportMeshGlb');
    if (!stl && !glb) return;
    var ok = isExportable(meshObjectGeometry(obj));
    [stl, glb].forEach(function (btn) {
        if (!btn) return;
        btn.disabled = !ok;
        btn.title = ok ? btn.dataset.readyTitle || btn.title
            : 'Nothing to export yet — "' + obj.name + '" has no triangulated faces. ' +
              'Triangulate its planes first.';
        if (ok && !btn.dataset.readyTitle) btn.dataset.readyTitle = btn.title;
    });
}

/**
 * Write the selected object out, in `format` ('stl' | 'glb').
 *
 * The geometry is the SAME one the panel reports on — origin frame applied,
 * scale 1 — so the file and the badge above it cannot describe different
 * shapes. Scale 1 means the calibration's own millimetres reach the file
 * unscaled; nothing here invents a unit the calibration never stated.
 * @private
 */
function exportSelected(format) {
    var obj = getSelectedMeshObject();
    if (!obj) return;
    var geometry = meshObjectGeometry(obj);
    var bytes = format === 'stl'
        ? meshObjectToSTL(geometry, { name: obj.name })
        : meshObjectToGLB(geometry, { name: obj.name, color: obj.color });
    if (!bytes) {
        setStatus('Nothing to export — "' + obj.name + '" has no triangulated faces yet');
        return;
    }
    var filename = meshFilenameStem(obj.name) + '.' + format;
    downloadBytes(bytes, filename, format === 'stl'
        ? 'model/stl' : 'model/gltf-binary');
    var c = geometry.connectivity;
    setStatus('Exported "' + obj.name + '" as ' + filename + ' — ' +
        (geometry.triangles.length / 3) + ' triangles, ' + c.vertices + ' vertices' +
        (format === 'glb' ? ' (Y-up, as glTF requires)' : ' (Z-up millimetres)'));
}

/**
 * The connectivity read-out.
 *
 * Written to be actionable rather than exhaustive, and it says NOTHING the
 * reader cannot act on. The counts are there, but what the user needs is the
 * next move: a multi-shell object says that joining requires SHARING a node, and
 * a coincident pair names the two nodes to merge. Those are the whole point —
 * the raw numbers are diagnosable only by someone who already knows the terms.
 *
 * Which is also why an ordinary single-shell OPEN object gets no line: "open"
 * is the normal state of a cage with no lid, not a finding, and saying it in
 * terms like "naked edge" made the panel owe the reader a definition it never
 * paid. Same reason there is no Shape column any more.
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

    // Winding is DERIVED and has no user control (see
    // `pose/mesh-object-geometry.js`), so the report does not discuss it — a
    // read-out the reader cannot act on is noise, and it was the longest thing
    // in the box. A single-shell open object says nothing here at all: the
    // counts line above is the whole story, and "open" is the ordinary state
    // for a cage with no lid rather than a finding.
    if (c.isClosed) {
        box.appendChild(line('Closed — volume ' + fmt(c.volume) + '.', 'ok'));
    } else if (c.shells > 1) {
        box.appendChild(line(summary.text + ' — these planes are not all joined. ' +
            'Two planes belong to the same shell only when they SHARE a node.', 'warn'));
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

/**
 * The planes IN this object, one row each, with an × to take one back out.
 *
 * A list of members rather than a checkbox against every plane in the project:
 * membership is the thing being edited, so it is what the panel shows, and the
 * list stays the length of the object instead of the length of the project.
 * Planes are ADDED through the picker below it (`renderAddPlaneSelect`), the
 * same pick-and-add idiom the Planes section uses to put an existing node in a
 * plane.
 *
 * A member whose plane has since been deleted still gets a row — greyed, named
 * by id — because it is still in `planeIds` and its × is the only way to clear
 * it. Silently hiding it would leave the count in the table saying "−1" with
 * nothing on screen to act on.
 * @private
 */
function renderMembers(obj, model) {
    var box = document.getElementById('meshObjectMembers');
    var empty = document.getElementById('meshObjectMembersEmpty');
    if (!box) return;
    box.textContent = '';

    var ids = obj.planeIds;
    if (empty) empty.style.display = ids.length ? 'none' : '';
    if (box) box.style.display = ids.length ? '' : 'none';

    ids.forEach(function (planeId) {
        var plane = model.getPlane(planeId);
        var row = document.createElement('div');
        row.className = 'mesh-object-member';
        if (!plane) row.classList.add('mesh-object-member-dangling');

        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch';
        swatch.style.background = plane ? plane.color : 'transparent';

        var label = document.createElement('span');
        label.className = 'mesh-object-member-name';
        label.textContent = plane ? plane.name : '(deleted plane #' + planeId + ')';

        var count = document.createElement('span');
        count.className = 'mesh-object-member-count';
        count.textContent = plane ? plane.nodeIds.length + ' nodes' : 'no longer exists';

        row.appendChild(swatch);
        row.appendChild(label);
        row.appendChild(count);
        row.appendChild(makeDeleteButton(
            plane
                ? 'Remove "' + plane.name + '" from this object. The plane itself is NOT deleted.'
                : 'Forget this deleted plane.',
            function () {
                if (obj.removePlane(planeId)) {
                    markDirty();
                    notifyViewport();
                }
            }
        ));
        box.appendChild(row);
    });
}

/**
 * The picker for adding a plane, offering only NON-members.
 *
 * Mirrors the Planes section's "+ Add" for an existing node, down to keying the
 * options by plane ID rather than name — names are user-editable and can
 * collide. An empty list is a real state (every plane is already in this
 * object, or there are no planes yet) and it is said in words rather than left
 * as a dead dropdown.
 * @private
 */
function renderAddPlaneSelect(obj, model) {
    var select = document.getElementById('meshObjectAddPlaneSelect');
    var btn = document.getElementById('btnAddMeshObjectPlane');
    var hint = document.getElementById('meshObjectAddPlaneHint');
    if (select) select.textContent = '';

    var candidates = model.planes.filter(function (p) { return !obj.hasPlane(p.id); });

    if (select) {
        candidates.forEach(function (plane) {
            var opt = document.createElement('option');
            opt.value = String(plane.id);
            opt.textContent = plane.name + '  (' + plane.nodeIds.length + ' nodes)';
            select.appendChild(opt);
        });
        select.disabled = candidates.length === 0;
    }
    if (btn) btn.disabled = candidates.length === 0;
    if (hint) {
        if (!model.planes.length) {
            hint.textContent = 'No planes in this project yet — define one above first.';
        } else if (!candidates.length) {
            hint.textContent = 'Every plane in the project is already in "' + obj.name + '".';
        } else {
            hint.textContent = '';
        }
    }
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

    var addPlane = document.getElementById('btnAddMeshObjectPlane');
    if (addPlane) {
        addPlane.addEventListener('click', function () {
            var obj = getSelectedMeshObject();
            if (!obj) { setStatus('No 3D mesh object selected', 'warning'); return; }
            var select = document.getElementById('meshObjectAddPlaneSelect');
            // `getPlane` matches with ===, and the DOM hands back a string.
            var id = select ? parseInt(select.value, 10) : NaN;
            var plane = isNaN(id) ? null : planeModel().getPlane(id);
            if (!plane) {
                setStatus('Pick a plane to add — define one above if there are none',
                    'warning');
                return;
            }
            if (obj.addPlane(plane.id)) {
                setStatus('Added "' + plane.name + '" to "' + obj.name + '"');
                markDirty();
                notifyViewport();
            }
        });
    }

    // Export writes a file and changes nothing, so neither button marks the
    // project dirty — the same reason the appearance sliders do not.
    var stl = document.getElementById('btnExportMeshStl');
    if (stl) stl.addEventListener('click', function () { exportSelected('stl'); });
    var glb = document.getElementById('btnExportMeshGlb');
    if (glb) glb.addEventListener('click', function () { exportSelected('glb'); });
}
