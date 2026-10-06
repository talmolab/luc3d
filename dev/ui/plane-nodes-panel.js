// ui/plane-nodes-panel.js — Section 1 of the Define Planes panel (of two): the global
// Nodes table, the padlock (pin) picker, the typed x/y/z editor and node
// deletion.
//
// Split out of `ui/plane-definition.js`, which was 4,474 lines. This is the
// largest cohesive cluster in that file (~880 lines) and the one with the most
// self-contained state: the pin popover singleton below is read and written
// nowhere else in the app.
//
// Nothing outside imports these renderers directly — the hub's
// `refreshPlanePanel` calls them, and it keeps doing so — so no call site
// changed and nothing new is added to this feature's public surface.
//
// **The model state stays in the hub.** `planeState` (and the one
// `new PlaneModel()` on it) is imported, never redeclared: a second copy would
// diverge silently, since the tests assert behavior rather than object
// identity. Every binding imported from `./plane-definition.js` is circular and
// is read INSIDE a function body only, never at this module's top level, where
// a circular import is still `undefined`. That rule is what makes this feature's
// existing cycles safe, and it applies here unchanged.

import { state } from './app-state.js?v=9b087dc831a8';
import { setInfoTip } from './info-tip.js?v=9b087dc831a8';
import { showPlaneDialog } from './plane-dialog.js?v=9b087dc831a8';
import { setStatus, markDirty } from '../import-export/save-load.js?v=9b087dc831a8';
import { PIN_STATES } from '../pose/plane-nodes.js?v=9b087dc831a8';
import { nodeFreezeState } from '../pose/plane-data.js?v=9b087dc831a8';
import { reprojectPointCamera } from '../pose/triangulation.js?v=9b087dc831a8';
import { isOriginModeActive } from './origin-definition.js?v=9b087dc831a8';
import {
    ICON_PIN, ICON_INFO, makeDeleteButton, setEmptyState, redraw,
    planeModel, planePool, planeState, refreshPlanePanel,
    refreshTriangulationErrors, syncPlanes3D, syncSelectedNode3D,
} from './plane-definition.js?v=9b087dc831a8';

/**
 * User-facing names for the three pin states.
 *
 * "Unlocked" rather than the "Free" this said while the control was a
 * `<select>`: the control is a padlock now, and the three names have to be the
 * three things a padlock can be. It also matches the wording of the Pin
 * column's own explanation.
 * @private
 */
const PIN_LABELS = {
    'none': 'Unlocked',
    'plane-locked': 'Plane-locked',
    'locked': 'Locked',
};

/** What each state promises, as the control's tooltip. @private */
const PIN_TITLES = {
    'none': 'Unlocked (mutable): triangulation, fitting and dragging may all ' +
        'move this node\u2019s 3D position.',
    'plane-locked': 'Plane-locked (mutable within its planes): this node may ' +
        'move, but only within EVERY plane it belongs to — one plane\u2019s ' +
        'surface, the line two of them share, or the single point three meet ' +
        'at. It is not an anchor, so a fit is still free to move it, but a ' +
        'solve that would take it off projects it back on.',
    'locked': 'Locked (immutable): this 3D position is frozen. Nothing — 2D editing, ' +
        'triangulation, fitting or dragging — may move it, and a fit is ' +
        'constrained to pass through it. Set Angle Between Planes locks the ' +
        'nodes it moves, so the angle survives a later solve.',
};

/**
 * Section 1 — the Nodes table: the GLOBAL POOL, on its own, as a top-level
 * section.
 *
 * It is deliberately NOT inside the plane editor. A node outlives the planes
 * that reference it and may belong to several at once, so presenting node
 * creation as a sub-step of editing one plane misstates the model. Everything
 * in this table acts on the NODE — renaming, recolouring, pinning and deleting
 * all apply to every plane using it — and there is no membership column: which
 * plane a node is IN is the Planes section's business.
 */
export function renderNodesTable() {
    var tbody = document.querySelector('#planeNodesTable tbody');
    if (!tbody) return;
    // A rebuild throws away the button the popover is anchored to, so it has to
    // go with it rather than float over the new rows.
    closePinPopover();
    tbody.textContent = '';

    var model = planeModel();
    var pool = model.pool;
    var nodes = pool.nodes;
    setEmptyState('planeNodesTable', 'planeNodesEmpty', nodes.length === 0);
    renderPinInfoButton();

    // A deleted node cannot stay selected: its row is gone and so is the
    // corner the marker was sitting on. Checked here rather than in the delete
    // path because every route that removes a node ends in this rebuild.
    if (planeState.selectedNodeId != null && !pool.getNode(planeState.selectedNodeId)) {
        planeState.selectedNodeId = null;
        syncSelectedNode3D();
    }

    nodes.forEach(function (node) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-plane-node-id', String(node.id));
        var st = nodeFreezeState(node);
        var usedBy = model.planesForNode(node.id);
        var expanded = planeState.expandedNodes.has(node.id);
        // `plane-node-main` marks the IDENTITY row — the one a node's name,
        // colour, pin and delete button live on. `plane-node-row` stays on both
        // rows, because every state cue styled off it (shared, unused,
        // dead-end) has to run down the whole node.
        tr.className = 'plane-node-row plane-node-main plane-node-' + st +
            // A node in no plane is NOT an error — planes are deleted without
            // taking their nodes, so this is a normal resting state. It is
            // dimmed only because nothing draws it on any view yet.
            (usedBy.length === 0 ? ' plane-node-unused' : '') +
            (usedBy.length > 1 ? ' plane-node-shared' : '') +
            (node.id === planeState.selectedNodeId ? ' plane-node-selected' : '') +
            (expanded ? ' plane-node-open' : '');

        // --- Expander: reveals this node's coordinates ---
        var tdExpand = document.createElement('td');
        var expandBtn = document.createElement('button');
        expandBtn.className = 'plane-node-expander' + (expanded ? ' open' : '');
        expandBtn.innerHTML = '<span class="plane-caret">▶</span>';
        expandBtn.title = expanded
            ? 'Hide this node’s 3D position'
            : 'Show this node’s 3D position and the planes using it';
        expandBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (planeState.expandedNodes.has(node.id)) planeState.expandedNodes.delete(node.id);
            else planeState.expandedNodes.add(node.id);
            // Just this table: expanding a node changes nothing else in the
            // panel, and a full refresh would throw away a name being typed in
            // some other row.
            renderNodesTable();
        });
        tdExpand.appendChild(expandBtn);

        // Per-node colour, FIRST in the row: it is how you tell this corner
        // apart from the others on every view and in 3D, so it reads as the
        // node's identity rather than as one of its properties. Scoped to the
        // NODE, so the colour is the same everywhere.
        var tdColor = document.createElement('td');
        var color = document.createElement('input');
        color.type = 'color';
        color.className = 'plane-node-color';
        color.value = node.color;
        color.title = 'Colour for "' + node.name + '" on every view and in every plane';
        color.addEventListener('input', function () {
            node.color = color.value;
            redraw();
        });
        color.addEventListener('change', function () {
            node.color = color.value;
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        });
        color.addEventListener('click', function (e) { e.stopPropagation(); });
        tdColor.appendChild(color);

        // --- Name (renames the node everywhere it is used) ---
        var tdName = document.createElement('td');
        var input = document.createElement('input');
        input.type = 'text';
        input.value = node.name;
        // Plain text until you go for it: a row of boxed fields is what made
        // this list read as a form rather than as a list of nodes. The input is
        // full-width, so the whole row is a rename target.
        input.className = 'plane-node-name';
        input.title = 'Node name, shared by every plane using it';
        input.addEventListener('change', function () {
            var newName = input.value.trim();
            if (!newName) { input.value = node.name; return; }
            node.name = newName;
            markDirty();
            refreshPlanePanel();
            redraw();
        });
        tdName.appendChild(input);

        // --- Pin: one icon, three states ---
        // An icon rather than the <select> this used to be. The select had to
        // be wide enough for the words "Plane-locked", and it carried a second
        // line naming the plane a held node is held in — two lines of chrome in
        // every row to say something that is usually "Free". The state is now a
        // padlock you can read at a glance and change in one click, and the
        // words live in its tooltip and in the expanded panel.
        var tdPin = document.createElement('td');
        var pinBtn = document.createElement('button');
        pinBtn.className = 'plane-node-pin-btn plane-node-pin-' + node.pin;
        pinBtn.innerHTML = ICON_PIN[node.pin] || ICON_PIN.none;
        pinBtn.setAttribute('data-pin', node.pin);
        pinBtn.setAttribute('aria-label', 'Pin: ' + PIN_LABELS[node.pin]);
        pinBtn.title = PIN_LABELS[node.pin] + ' — ' +
            (PIN_TITLES[node.pin] || PIN_TITLES.none) +
            (node.pin === 'plane-locked' ? ' ' + heldInText(node, model) : '') +
            '\nClick to change.';
        pinBtn.addEventListener('mouseenter', function () { openPinPopover(pinBtn, node); });
        pinBtn.addEventListener('mouseleave', function () { schedulePinPopoverClose(); });
        pinBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            // Click PINS it open, so the picker is usable without holding the
            // pointer steady — and a second click dismisses it.
            if (pinPopover && pinPopover.nodeId === node.id && pinPopover.sticky) closePinPopover();
            else openPinPopover(pinBtn, node, true);
        });
        pinBtn.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            openPinPopover(pinBtn, node, true);
        });
        tdPin.appendChild(pinBtn);

        // The long form of the node's 3D state stays reachable on the row, as
        // it has since the 3D column went away.
        tr.title = nodeStateTitle(node, st, model);

        var tdDel = document.createElement('td');
        var delBtn = makeDeleteButton(
            'Delete "' + node.name + '" from the PROJECT: every plane using it, ' +
            'its 3D, and its 2D on every view. To take it out of ONE plane, use ' +
            'the × in Nodes In This Plane instead.',
            function () { deleteNodeWithConfirm(node, usedBy); });
        // Quiet until you reach for it. The shared delete button is red at
        // rest, which is right in a table you visit to remove something and
        // wrong in a list of six nodes you are reading — six red × down the
        // edge is most of what made this list shout. The inline colour has to
        // be cleared for the hover rule to reach it.
        delBtn.classList.add('plane-node-del');
        delBtn.style.color = '';
        tdDel.appendChild(delBtn);

        tr.appendChild(tdExpand);
        tr.appendChild(tdColor);
        tr.appendChild(tdName);
        tr.appendChild(tdPin);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
        // The coordinates are one click away rather than always on screen:
        // nine nodes of nine numbers is the clutter the list had, and a
        // position is something you check or set deliberately.
        if (expanded) tbody.appendChild(renderNodeDetailRow(node, st, usedBy, model));
    });
}

/**
 * The set a plane-locked node may move in, named.
 *
 * The pin holds a node in every plane it belongs to, so the answer is not a
 * plane name but the INTERSECTION of however many planes it is in — which is
 * why the rank is what picks the word. Rank 1 with several planes means they
 * are effectively the same surface; naming them all is more use than picking
 * one of them arbitrarily.
 * @param {{rank:number, planes:{name:string}[]}} lock
 * @returns {string|null} null when nothing currently constrains the node.
 * @private
 */
export function planeLockWhere(lock) {
    if (!lock || !lock.rank || !lock.planes.length) return null;
    var list = quotedList(lock.planes.map(function (p) { return p.name; }));
    if (lock.rank >= 3) return 'the point where ' + list + ' meet';
    if (lock.rank === 2) return 'the line where ' + list + ' meet';
    return lock.planes.length > 1 ? 'the plane ' + list + ' share' : list;
}

/** `\u201ca\u201d`, `\u201ca\u201d and \u201cb\u201d`, `\u201ca\u201d, \u201cb\u201d and \u201cc\u201d`. @private */
function quotedList(names) {
    var q = names.map(function (n) { return '\u201c' + n + '\u201d'; });
    if (q.length <= 1) return q[0] || '';
    return q.slice(0, -1).join(', ') + ' and ' + q[q.length - 1];
}

/** Where a plane-locked node is held, as a sentence. @private */
function heldInText(node, model) {
    var lock = model.planeLockForNode(node.id);
    var where = planeLockWhere(lock);
    if (!where) {
        return 'None of its planes can say where it is yet — each needs three ' +
            'other solved corners — so the restriction is inert.';
    }
    return 'Held to ' + where +
        (lock.rank >= 3 ? ', which is one position: it cannot move.' : '.');
}

/**
 * Enable the Pin column's info button and give it its explanation.
 *
 * The three states are the one thing in this panel that cannot be inferred from
 * what is on screen — a padlock shows WHICH state is in force but not what the
 * three of them mean — so the column carries the definition rather than leaving
 * it to be discovered one tooltip at a time.
 * @private
 */
export function renderPinInfoButton() {
    var btn = document.getElementById('planePinInfo');
    if (!btn || btn.dataset.wired) return;
    btn.innerHTML = ICON_INFO;
    // A button, so it is reachable by keyboard. The text shows BESIDE THE
    // POINTER (`ui/info-tip.js`) rather than going to `setStatus`, which
    // painted it in the status bar at the bottom-left of the window — the
    // furthest point on screen from the icon just clicked, and a bar that also
    // carries save results and errors. `setInfoTip` also takes `title` away,
    // so the native tooltip cannot repeat it a second later somewhere else.
    setInfoTip(btn, 'Nodes can be unlocked (mutable), locked (immutable), or ' +
        'plane-locked \u2014 free to move, but only within the planes it is in');
    btn.dataset.wired = '1';
}

// ============================================
// The pin picker
// ============================================
//
// One popover, reused. It FLOATS (position: fixed, anchored to the icon) rather
// than expanding inside the row, for two reasons: the row would otherwise have
// to reserve three icons' worth of width it only needs while the pointer is
// there, and `.plane-panel` scrolls — an absolutely positioned child would be
// clipped by its `overflow-y: auto` the moment it reached the top or bottom row.
//
// Fixed positioning does not follow a scroll, so a scroll has to be answered.
// It REPOSITIONS rather than dismissing, and only closes once the icon itself
// has scrolled out of the panel. Dismissing was the first attempt and it was
// wrong twice over: a `scroll` event is delivered on the next frame, so a
// scroll that brought the row into view in the first place arrived AFTER the
// popover opened and shut it again — the picker could not be opened at all on
// a row you had just scrolled to.

/** @type {{el:HTMLElement, anchor:HTMLElement, nodeId:number, sticky:boolean}|null} @private */
var pinPopover = null;
/** @type {number|null} @private */
var pinPopoverTimer = null;

/** @private */
function closePinPopover() {
    if (pinPopoverTimer !== null) { clearTimeout(pinPopoverTimer); pinPopoverTimer = null; }
    if (!pinPopover) return;
    if (pinPopover.el.parentNode) pinPopover.el.remove();
    document.removeEventListener('keydown', onPinPopoverKey, true);
    document.removeEventListener('mousedown', onPinPopoverOutside, true);
    window.removeEventListener('resize', onPinPopoverReflow);
    var panel = document.getElementById('planePanel');
    if (panel) panel.removeEventListener('scroll', onPinPopoverReflow);
    pinPopover = null;
}

/**
 * Put the popover next to its icon, above it where there is room.
 *
 * Above and right-aligned: the icon sits at the right edge of a panel on the
 * right edge of the window, so leftwards and upwards is the only direction with
 * space. Clamped to the viewport, and flipped below when the row is near the
 * top.
 * @private
 */
function positionPinPopover(el, anchor) {
    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth || 78;
    var h = el.offsetHeight || 26;
    var left = Math.min(window.innerWidth - w - 6, Math.max(6, r.right - w));
    var top = r.top - h - 4;
    if (top < 4) top = r.bottom + 4;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
}

/**
 * Follow the icon through a scroll or a resize, and let go when it leaves.
 * @private
 */
function onPinPopoverReflow() {
    if (!pinPopover) return;
    var anchor = pinPopover.anchor;
    if (!anchor.isConnected) { closePinPopover(); return; }
    var panel = document.getElementById('planePanel');
    var ar = anchor.getBoundingClientRect();
    if (panel) {
        // Out of the panel's own window: the icon is no longer on screen, so a
        // picker floating where it used to be would point at nothing.
        var pr = panel.getBoundingClientRect();
        if (ar.bottom < pr.top || ar.top > pr.bottom) { closePinPopover(); return; }
    }
    positionPinPopover(pinPopover.el, anchor);
}

/**
 * Close, but not instantly: the pointer has to cross a few pixels of row to get
 * from the icon to the picker, and closing on the way would make the control
 * unusable.
 * @private
 */
function schedulePinPopoverClose() {
    if (!pinPopover || pinPopover.sticky) return;
    if (pinPopoverTimer !== null) clearTimeout(pinPopoverTimer);
    pinPopoverTimer = setTimeout(closePinPopover, 260);
}

/** @private */
function onPinPopoverKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closePinPopover();
}

/** @private */
function onPinPopoverOutside(e) {
    if (!pinPopover) return;
    if (pinPopover.el.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('.plane-node-pin-btn')) return;
    closePinPopover();
}

/**
 * Show the three states for one node, with the current one dimmed.
 *
 * The current state is shown and NOT clickable: it is already in force, so it
 * is there to say "this is what you have" rather than to be picked again.
 * @param {HTMLElement} anchor @param {PlaneNode} node @param {boolean} [sticky]
 * @private
 */
function openPinPopover(anchor, node, sticky) {
    if (pinPopoverTimer !== null) { clearTimeout(pinPopoverTimer); pinPopoverTimer = null; }
    if (pinPopover && pinPopover.nodeId === node.id) {
        if (sticky) pinPopover.sticky = true;
        return;
    }
    closePinPopover();

    var model = planeModel();
    var el = document.createElement('div');
    el.className = 'plane-pin-popover';
    el.id = 'planePinPopover';
    el.setAttribute('role', 'group');
    el.setAttribute('data-node-id', String(node.id));

    PIN_STATES.forEach(function (stt) {
        var opt = document.createElement('button');
        var current = node.pin === stt;
        opt.className = 'plane-pin-option plane-node-pin-' + stt + (current ? ' is-current' : '');
        opt.innerHTML = ICON_PIN[stt];
        opt.setAttribute('data-pin', stt);
        opt.setAttribute('aria-label', PIN_LABELS[stt]);
        opt.title = current
            ? PIN_LABELS[stt] + ' (current)' +
              (stt === 'plane-locked' ? ' — ' + heldInText(node, model) : '')
            : 'Set to ' + PIN_LABELS[stt] + ' — ' + PIN_TITLES[stt];
        opt.disabled = current;
        opt.addEventListener('click', function (e) {
            e.stopPropagation();
            closePinPopover();
            setNodePin(node, stt);
        });
        el.appendChild(opt);
    });

    document.body.appendChild(el);
    positionPinPopover(el, anchor);

    el.addEventListener('mouseenter', function () {
        if (pinPopoverTimer !== null) { clearTimeout(pinPopoverTimer); pinPopoverTimer = null; }
    });
    el.addEventListener('mouseleave', function () { schedulePinPopoverClose(); });
    document.addEventListener('keydown', onPinPopoverKey, true);
    document.addEventListener('mousedown', onPinPopoverOutside, true);
    window.addEventListener('resize', onPinPopoverReflow);
    var panel = document.getElementById('planePanel');
    if (panel) panel.addEventListener('scroll', onPinPopoverReflow);

    pinPopover = { el: el, anchor: anchor, nodeId: node.id, sticky: !!sticky };
}

/**
 * Put a node into one of the three pin states.
 *
 * Was the `<select>`'s change handler; extracted when the control became an
 * icon, because the rules are about the MODEL and not about the widget:
 *   - Set Origin Mode refuses the change (`lockUI` reaches `button.disabled`,
 *     but this path is reachable from the popover, so it says so itself).
 *   - `plane-locked` is refused for a node in no plane, where "stays in its
 *     planes" has no meaning. It nominates none: the pin holds the node in
 *     every plane it belongs to, so adding it to a wall later simply adds that
 *     wall to what holds it.
 *   - Any stored fit of a plane standing on this node is dropped: changing a
 *     pin changes what a fit is ALLOWED to do, so a fit solved under the old
 *     rules must not be left looking valid.
 * @param {PlaneNode} node
 * @param {'none'|'plane-locked'|'locked'} value
 * @returns {boolean} True when the pin changed.
 * @private
 */
function setNodePin(node, value) {
    var model = planeModel();
    if (isOriginModeActive()) {
        setStatus('Leave Set Origin Mode before changing a pin', 'warning');
        return false;
    }
    var planes = model.planesForNode(node.id);
    if (value === 'plane-locked' && !planes.length) {
        setStatus('"' + node.name + '" is in no plane, so it cannot be ' +
            'Plane-locked — add it to a plane first', 'warning');
        return false;
    }
    model.pool.setPin(node.id, value);
    for (var i = 0; i < planes.length; i++) planes[i].planeFit = null;
    markDirty();
    syncPlanes3D();
    refreshPlanePanel();
    redraw();
    // What holds the node is asked AFTER the change — this function just
    // cleared the stored fits, so the answer comes from derived planes, which
    // is the same answer every other reader of the pin now gets.
    //
    // A plane the node is in but that cannot yet say where it is still gets
    // NAMED, with the reason: "Plane-locked" alone would leave the user looking
    // for a restriction the panel is not showing.
    var msg = '"' + node.name + '" is now ' + PIN_LABELS[value];
    if (value === 'plane-locked') {
        var where = planeLockWhere(model.planeLockForNode(node.id));
        msg += where ? ' to ' + where
            : ' in ' + quotedList(planes.map(function (q) { return q.name; })) +
              ', but ' + (planes.length > 1 ? 'none of them has' : 'it does not have') +
              ' three other solved corners yet, so nothing holds it';
    }
    setStatus(msg);
    return true;
}

/**
 * A node's expanded panel: its 3D position, and the planes using it.
 *
 * Indented under the node and given its own row, so the list above stays a list
 * of nodes. Two things live here, and they are the two the row cannot hold:
 *   - the POSITION, three editable fields. A full-width line, because three
 *     legible number fields do not fit beside a name, a swatch and two icons in
 *     a 300px panel at any reasonable field width.
 *   - the PLANES using this node, which is the whole point of a project-wide
 *     pool and was previously only in a tooltip. For a `plane-locked` node
 *     EVERY plane currently holding it is marked here with its own padlock —
 *     where the Pin select's second line went, and how two marks say the
 *     corner is down to a line.
 *
 * Editing writes the NODE's 3D — the single source of truth for every plane
 * using it — so typing a surveyed corner here moves it in every plane at once.
 *
 * @param {PlaneNode} node
 * @param {string} st - `nodeFreezeState(node)`, so the pair matches.
 * @param {PlaneSkeleton[]} usedBy
 * @param {PlaneModel} model
 * @returns {HTMLTableRowElement}
 * @private
 */
function renderNodeDetailRow(node, st, usedBy, model) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-plane-node-id', String(node.id));
    tr.className = 'plane-node-row plane-node-detail plane-node-' + st +
        (usedBy.length === 0 ? ' plane-node-unused' : '') +
        (usedBy.length > 1 ? ' plane-node-shared' : '') +
        (node.id === planeState.selectedNodeId ? ' plane-node-selected' : '');

    var td = document.createElement('td');
    td.colSpan = 5;
    var body = document.createElement('div');
    body.className = 'plane-node-detail-body';

    var line = document.createElement('div');
    line.className = 'plane-node-xyz-line';
    var locked = node.immutable;
    var stored = node.getPoint3d();
    var inputs = [];
    for (var k = 0; k < 3; k++) {
        var cell = document.createElement('span');
        cell.className = 'plane-node-xyz-cell';
        var lab = document.createElement('span');
        lab.className = 'plane-node-xyz-label';
        lab.textContent = XYZ_AXES[k];
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.inputMode = 'decimal';
        inp.className = 'plane-node-xyz-input';
        inp.value = stored ? fmtXyz(stored[k]) : '';
        inp.placeholder = '—';
        inp.setAttribute('data-axis', XYZ_AXES[k]);
        // A Locked node is read-only HERE too, which is what the pin promises:
        // a field that took a value and then refused to keep it would be worse
        // than one that cannot be typed in.
        inp.disabled = locked;
        inp.title = locked
            ? '"' + node.name + '" is Locked, so its position cannot be typed ' +
              'over. Set the pin to unlocked (or plane-locked) to edit it.'
            : XYZ_AXES[k].toUpperCase() + ' of "' + node.name + '" in ' +
              'calibration world units — the same frame the cameras were ' +
              'calibrated in. Editing it moves this corner in every plane ' +
              'using the node, and rewrites its 2D on every view it is placed ' +
              'on to match.';
        cell.appendChild(lab);
        cell.appendChild(inp);
        line.appendChild(cell);
        inputs.push(inp);
    }
    if (!locked) {
        inputs.forEach(function (inp2) {
            // Commit on `change` (blur or Enter) with revert-on-invalid, the
            // panel's convention. NOT on `input`: a half-typed "-" or "1e" is
            // not a position, and writing per keystroke would reproject the 2D
            // on every one.
            inp2.addEventListener('change', function () { commitNodeXyz(node, inputs); });
        });
    }
    body.appendChild(line);

    var planesLine = document.createElement('div');
    planesLine.className = 'plane-node-planes';
    if (usedBy.length === 0) {
        planesLine.classList.add('plane-node-planes-none');
        planesLine.textContent = 'In no plane yet — use + Add in Planes';
        planesLine.title = 'A node in no plane is a normal resting state: ' +
            'deleting a plane keeps its nodes. Nothing draws it on any view ' +
            'until some plane uses it.';
    } else {
        var lead = document.createElement('span');
        lead.className = 'plane-node-planes-label';
        lead.textContent = usedBy.length > 1 ? 'Shared by' : 'In';
        planesLine.appendChild(lead);
        var lock = model.planeLockForNode(node.id);
        var holderIds = lock.planes.map(function (p) { return p.id; });
        usedBy.forEach(function (plane) {
            var chip = document.createElement('span');
            chip.className = 'plane-node-plane-chip';
            var dot = document.createElement('span');
            dot.className = 'plane-node-plane-dot';
            dot.style.background = plane.color;
            chip.appendChild(dot);
            chip.appendChild(document.createTextNode(plane.name));
            // EVERY plane that can currently say where this node is gets the
            // padlock, not one nominated plane: the pin holds it in all of
            // them at once, and two marks is exactly how the user reads that
            // the corner is down to a line. A plane with no usable fit yet
            // cannot hold anything, so it is left plain rather than promising
            // a restriction that is not in force.
            var isHolder = holderIds && holderIds.indexOf(plane.id) >= 0;
            if (isHolder) {
                chip.classList.add('plane-node-plane-holder');
                var mark = document.createElement('span');
                mark.className = 'plane-node-plane-mark';
                mark.innerHTML = ICON_PIN['plane-locked'];
                chip.appendChild(mark);
                chip.title = '"' + node.name + '" is Plane-locked: it may move, ' +
                    'but only within "' + plane.name + '"' +
                    (lock.planes.length > 1 ? ' and the other planes marked here.' : '.');
            } else {
                chip.title = '"' + node.name + '" is one of "' + plane.name + '"’s nodes' +
                    (node.pin === 'plane-locked'
                        ? ' — it cannot hold the node until three of its other ' +
                          'corners are solved'
                        : '');
            }
            planesLine.appendChild(chip);
        });
        if (node.pin === 'plane-locked' && !lock.rank) {
            var stale = document.createElement('span');
            stale.className = 'plane-node-planes-stale';
            stale.textContent = 'nothing holds it yet';
            stale.title = 'None of this node’s planes has three other solved ' +
                'corners, so none of them can say where it is and the ' +
                'restriction is inert.';
            planesLine.appendChild(stale);
        }
    }
    body.appendChild(planesLine);

    td.appendChild(body);
    tr.appendChild(td);
    return tr;
}

/** The three axes, in storage order. @private */
const XYZ_AXES = ['x', 'y', 'z'];

/**
 * A coordinate as the panel shows it.
 *
 * Four decimals, trailing zeros trimmed. The stored value is a double and the
 * display is lossy, which is why `commitNodeXyz` compares against this exact
 * string rather than re-parsing every field — see the note there.
 * @param {number} v @returns {string}
 * @private
 */
function fmtXyz(v) {
    if (!isFinite(v)) return '';
    return String(Number(v.toFixed(4)));
}

/**
 * Commit a typed 3D position for a pool node.
 *
 * All three fields are read, not just the one that fired: a position is a
 * triple, and a node with no 3D at all is being ENTERED rather than edited, so
 * the first two numbers typed have to survive until the third arrives.
 *
 * @param {PlaneNode} node
 * @param {HTMLInputElement[]} inputs - x, y, z, in that order.
 * @private
 */
function commitNodeXyz(node, inputs) {
    var stored = node.getPoint3d();
    if (node.immutable) {
        // Belt and braces: the inputs are `disabled`, so this is only reachable
        // if the pin changed under an open field.
        showStoredXyz(node, inputs);
        setStatus('"' + node.name + '" is Locked — set the pin to unlocked to ' +
            'type a new position', 'warning');
        return;
    }

    var vals = [];
    var bad = false;
    for (var k = 0; k < 3; k++) {
        var raw = String(inputs[k].value).trim();
        // A field still showing exactly what we printed keeps its FULL stored
        // double. Re-parsing it would round the two axes the user never touched
        // to the four decimals the display shows, so editing z would silently
        // move x.
        if (stored && raw === fmtXyz(stored[k])) { vals.push(stored[k]); continue; }
        var v = (raw === '') ? NaN : Number(raw);
        if (!isFinite(v)) bad = true;
        vals.push(v);
    }

    if (bad) {
        if (stored) {
            setStatus('A position needs three finite numbers — "' + node.name +
                '" is unchanged', 'warning');
            showStoredXyz(node, inputs);
        } else {
            // Nothing to revert to, and nothing to write yet. Leave what is
            // typed alone: this is a node being given its first position.
            setStatus('Enter x, y and z to place "' + node.name + '" in 3D');
        }
        return;
    }
    applyTypedNodePoint(node, vals);
}

/** Put the node's stored position back in its fields. @private */
function showStoredXyz(node, inputs) {
    var stored = node.getPoint3d();
    for (var k = 0; k < 3; k++) inputs[k].value = stored ? fmtXyz(stored[k]) : '';
}

/**
 * Write a hand-entered 3D position, and make the rest of the app agree with it.
 *
 * The same sequence as a 3D corner drag (`onPlaneNodeDragged3D`), and for the
 * same reason: **the 2D follows the 3D here.** The user has just asserted where
 * this corner IS, so every view it is placed on is rewritten to the exact
 * reprojection of that assertion — the reverse of every other edit path, and
 * the only consistent choice for an edit whose input is the 3D itself.
 *
 * PLANE-LOCKED is honoured through `constrainPoint3dForNode`, the model-side
 * enforcement a solve's publish path uses, so a held node lands on the nearest
 * point that satisfies every plane it is in rather than where it was typed —
 * and the status line says which, because a number that comes back different
 * from the one typed needs explaining.
 *
 * The stored `planeFit`s are deliberately NOT cleared. This is a corner nudge,
 * and the rule for those is the one in `syncPlanes3D`/the 3D drag: a corner
 * must not move the frame it defines, or the plane chases the point.
 *
 * @param {PlaneNode} node
 * @param {number[]} xyz
 * @private
 */
function applyTypedNodePoint(node, xyz) {
    var model = planeModel();
    var held = model.constrainPoint3dForNode(node.id, xyz);
    var projected = held[0] !== xyz[0] || held[1] !== xyz[1] || held[2] !== xyz[2];
    if (!node.setPoint3d(held)) {
        setStatus('"' + node.name + '" refused the write — it is Locked', 'warning');
        return;
    }

    var views = reprojectNodeIntoPlacedViews(node, model);
    var planes = model.planesForNode(node.id);
    for (var i = 0; i < planes.length; i++) refreshTriangulationErrors(planes[i]);

    markDirty();
    syncPlanes3D();
    refreshPlanePanel();
    redraw();

    var where = '(' + fmtXyz(held[0]) + ', ' + fmtXyz(held[1]) + ', ' +
        fmtXyz(held[2]) + ')';
    var msg = 'Set "' + node.name + '" to ' + where;
    if (projected) {
        var lockWhere = planeLockWhere(model.planeLockForNode(node.id));
        msg += ' — Plane-locked' + (lockWhere ? ' to ' + lockWhere : '') +
            ', so it was moved to the nearest point there';
    }
    if (views.length) msg += ' — 2D updated on ' + views.join(', ');
    setStatus(msg, 'success');
}

/**
 * Rewrite a node's 2D on every view it is actually drawn on.
 *
 * "Drawn on" is asked of the PLANES: a pool node shows up on a view only when
 * some plane containing it is placed there, which is the same question
 * `visibleNodeIndices` answers for hit testing.
 * @param {PlaneNode} node @param {PlaneModel} model
 * @returns {string[]} The view names written.
 * @private
 */
function reprojectNodeIntoPlacedViews(node, model) {
    var out = [];
    var session = state.session;
    var poolIdx = model.pool.indexOf(node.id);
    var xyz = node.getPoint3d();
    if (!session || !session.cameras || poolIdx < 0 || !xyz) return out;
    var planes = model.planesForNode(node.id);
    for (var c = 0; c < session.cameras.length; c++) {
        var cam = session.cameras[c];
        var placed = false;
        for (var p = 0; p < planes.length; p++) {
            if (model.isPlanePlaced(planes[p], cam.name)) { placed = true; break; }
        }
        if (!placed) continue;
        var inst = model.getInstance(cam.name);
        if (!inst || poolIdx >= inst.numNodes) continue;
        var uv = reprojectPointCamera(xyz, cam);
        if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
        inst.setPoint(poolIdx, uv[0], uv[1]);
        inst.modified = true;
        out.push(cam.name);
    }
    return out;
}

/**
 * Delete a pool node, asking first when it is load-bearing.
 *
 * Deleting a node is the one destructive act in this panel that reaches
 * BEYOND the plane being edited: it takes the node out of every plane that
 * references it and destroys its 2D on every view. When it is shared, or
 * pinned (a coordinate the user entered deliberately and no solve can
 * reproduce), the confirmation names exactly what is going.
 *
 * A node used by one plane and not pinned is deleted straight away — the ×
 * next to it is unambiguous, and the non-destructive alternative (taking it out
 * of one plane) is the × in the selected plane's own members table.
 *
 * @param {PlaneNode} node
 * @param {PlaneSkeleton[]} usedBy - Planes referencing it.
 */
function deleteNodeWithConfirm(node, usedBy) {
    var model = planeModel();
    var doIt = function () {
        model.deleteNode(node.id);
        markDirty();
        syncPlanes3D();
        refreshPlanePanel();
        redraw();
    };
    var pinned = node.immutable;
    if (usedBy.length < 2 && !pinned) { doIt(); return; }

    var parts = [];
    if (usedBy.length > 1) {
        parts.push('"' + node.name + '" is shared by ' + usedBy.length + ' planes (' +
            usedBy.map(function (p) { return p.name; }).join(', ') +
            '). Deleting it removes that corner from all of them — if they meet ' +
            'along it, they stop meeting.');
    }
    if (pinned) {
        parts.push('It is PINNED' +
            (node.hasPoint3d() ? ' at (' + node.getPoint3d().map(function (v) {
                return v.toFixed(1);
            }).join(', ') + ')' : '') +
            '. That coordinate is an input no solve can reproduce, so deleting ' +
            'it cannot be undone by re-triangulating.');
    }
    parts.push('Its 2D points on every view go with it.');
    showPlaneDialog({
        title: 'Delete node "' + node.name + '"?',
        message: parts.join(' '),
        confirmLabel: 'Delete node',
        onConfirm: doIt,
    });
}

/** Long-form explanation, including the coordinates when there are any. @private */
function nodeStateTitle(node, st, model) {
    var used = model.planesForNode(node.id);
    var where = used.length
        ? 'In ' + used.length + ' plane(s): ' +
          used.map(function (p) { return p.name; }).join(', ')
        // Not an error: planes are deleted without their nodes, so a node can
        // legitimately belong to nothing. It just is not drawn anywhere.
        : 'In no plane, so it is drawn on no view — put it in one with + Add ' +
          'in the Planes section';
    if (st === 'frozen-unsolved') {
        return where + '. PINNED BUT NEVER TRIANGULATED — a dead end: pinning is ' +
            'exactly what forbids a solve from giving it a 3D position. Unpin it, ' +
            'triangulate, then pin it again.';
    }
    if (!node.hasPoint3d()) return where + '. No 3D yet — triangulate the plane.';
    var q = node.getPoint3d();
    return where + '. 3D (' + q[0].toFixed(1) + ', ' + q[1].toFixed(1) + ', ' +
        q[2].toFixed(1) + ')' +
        (node.error != null ? ' — ' + node.error.toFixed(2) + ' px reprojection' : '') +
        (st === 'frozen' ? '. Pinned: frozen against every solve.' : '');
}

/**
 * Name the pinned-but-untriangulated nodes in the panel itself.
 *
 * This state cannot resolve itself: the pin is what stops a solve from ever
 * writing a 3D position, so a user who pins a node before triangulating gets a
 * node that silently contributes nothing and blocks every fit of every plane it
 * belongs to (`no_anchor_3d`). A tooltip is not read by someone who does not
 * already suspect a problem, so it is said in the open.
 */
export function renderFrozenWarning() {
    var host = document.getElementById('planeFrozenWarning');
    if (!host) return;
    var pool = planePool();
    var stuck = pool.nodes.filter(function (n) {
        return nodeFreezeState(n) === 'frozen-unsolved';
    });
    if (!stuck.length) {
        host.style.display = 'none';
        host.textContent = '';
        return;
    }
    host.style.display = '';
    host.textContent = (stuck.length === 1 ? 'Node ' : 'Nodes ') +
        stuck.map(function (n) { return '"' + n.name + '"'; }).join(', ') +
        (stuck.length === 1 ? ' is' : ' are') +
        ' pinned but have no 3D position. Pinning is what stops triangulation ' +
        'from giving them one, so they will stay empty and will block any fit ' +
        'of a plane they belong to. Unpin, triangulate, then pin again.';
}
