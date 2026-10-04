/**
 * ui/id-switch-highlight.js — an animated box around the two animals of the
 * selected ID-switch row, in every camera view, while the viewer is inside that
 * row's interval (1 s before they come close -> 1 s after they separate; the
 * same span as the row's progress bar).
 *
 * Drawn on its OWN canvas per view (`.id-switch-canvas`, appended to the view's
 * `.canvas-wrapper`), not the overlay canvas: the wrapper's CSS transform already
 * carries zoom / pan / rotation, the overlay redraw paths (which clear the overlay
 * canvas every frame) never touch it, and the overlay-video export does not
 * include it. A requestAnimationFrame loop runs ONLY while the frame is in the
 * interval, so the marching-ants outline moves even when paused; outside it the
 * canvases are cleared once and the loop stops. Boxes are recomputed only when
 * the frame changes.
 *
 * The animals are found per camera by their identity NAME at the current frame,
 * the way the overlays resolve identity: the per-frame identity of the instance's
 * track first (`session.getIdentityForTrack(trackIdx, camera, frame)`), else its
 * group's `identityId`; unlinked instances through
 * `session.getIdentityIdForUnlinkedInstance`. One box encloses both (or the one
 * visible in that view), labelled "id_a ↔ id_b" in the identities' colours.
 *
 * Driven by ui/id-switch-modal.js: `setIdSwitchHighlight` on row selection /
 * panel render, `updateIdSwitchHighlight(frame)` on every frame change (from
 * `updateIdSwitchProgress`).
 */

import { state } from './app-state.js?v=fb0406f5189e';
import { makeVideoToCanvasTransform } from './overlays.js?v=fb0406f5189e';

var _target = null;          // {nameA, nameB, p0, p1}
var _frame = -1;             // frame the boxes were computed for
var _boxes = new Map();      // view name -> {x0, y0, x1, y1} in video px, or absent
var _raf = 0;
var _canvases = new WeakMap();
var _cleared = true;

/** Select the pair + interval to highlight, or `null` to stop. */
export function setIdSwitchHighlight(target) {
    var same = _target && target && _target.nameA === target.nameA && _target.nameB === target.nameB &&
        _target.p0 === target.p0 && _target.p1 === target.p1;
    if (same) return;
    _target = target ? { nameA: target.nameA, nameB: target.nameB, p0: target.p0, p1: target.p1 } : null;
    _frame = -1;
    updateIdSwitchHighlight(state.currentFrame);
}

/** @returns {?{nameA, nameB, p0, p1}} the current target (tests). */
export function getIdSwitchHighlight() { return _target ? Object.assign({}, _target) : null; }

/** Called on every frame change: start / stop the animation and refresh the boxes. */
export function updateIdSwitchHighlight(frame) {
    var inRange = !!_target && frame >= _target.p0 && frame <= _target.p1;
    if (!inRange) { stop(); return; }
    if (frame !== _frame) { _frame = frame; computeBoxes(frame); }
    if (!_raf && typeof requestAnimationFrame === 'function') _raf = requestAnimationFrame(tick);
}

function stop() {
    if (_raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_raf);
    _raf = 0; _frame = -1; _boxes.clear();
    if (!_cleared) {
        (state.views || []).forEach(function (v) {
            var c = _canvases.get(v);
            if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
        });
        _cleared = true;
    }
}

/** The identity name of an instance at `frame` in `cam` (per-frame track identity first, then its group's). */
function identityName(session, inst, cam, frame, group) {
    var id = null;
    if (inst.trackIdx != null && session.getIdentityForTrack) {
        var ident = session.getIdentityForTrack(inst.trackIdx, cam, frame);
        if (ident) return ident.name;
    }
    if (group && group.identityId != null && group.identityId >= 0) id = group.identityId;
    else if (!group && session.getIdentityIdForUnlinkedInstance) id = session.getIdentityIdForUnlinkedInstance(cam, inst, frame);
    var g = id != null && session.getIdentity ? session.getIdentity(id) : null;
    return g ? g.name : null;
}

function extend(box, inst) {
    var n = inst.numNodes != null ? inst.numNodes : 0;
    for (var k = 0; k < n; k++) {
        if (inst.hasPoint && !inst.hasPoint(k)) continue;
        var x = inst.getX(k), y = inst.getY(k);
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < box.x0) box.x0 = x; if (y < box.y0) box.y0 = y;
        if (x > box.x1) box.x1 = x; if (y > box.y1) box.y1 = y;
    }
}

function computeBoxes(frame) {
    _boxes.clear();
    var session = state.session;
    if (!session || !_target) return;
    if (session.frameGroups && !session.frameGroups.has(frame)) return;     // lazy project: frame not resident
    var groups = (session.instanceGroups && session.instanceGroups.get(frame)) || [];
    var fg = session.getFrameGroup ? session.getFrameGroup(frame) : null;
    var names = [_target.nameA, _target.nameB];
    (state.views || []).forEach(function (v) {
        var cam = v.cameraName || v.name, box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, found = 0;
        groups.forEach(function (g) {
            var inst = g.getInstance ? g.getInstance(cam) : null;
            if (inst && names.indexOf(identityName(session, inst, cam, frame, g)) >= 0) { extend(box, inst); found++; }
        });
        if (fg && fg.getUnlinkedInstances) fg.getUnlinkedInstances(cam).forEach(function (u) {
            var inst = u && (u.instance || u);
            if (inst && inst.getX && names.indexOf(identityName(session, inst, cam, frame, null)) >= 0) { extend(box, inst); found++; }
        });
        if (found && box.x1 >= box.x0) _boxes.set(v.name, box);
    });
}

function canvasFor(v) {
    if (!v.wrapper || typeof document === 'undefined') return null;
    var c = _canvases.get(v);
    if (!c || c.parentNode !== v.wrapper) {
        c = document.createElement('canvas');
        c.className = 'id-switch-canvas';
        v.wrapper.appendChild(c);
        _canvases.set(v, c);
    }
    var zs = v.zoom && v.zoom.scale ? v.zoom.scale : 1;
    var w = Math.max(1, Math.round((v.videoWidth || 1) * zs)), h = Math.max(1, Math.round((v.videoHeight || 1) * zs));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
}

function colorOf(name) {
    var ids = (state.session && state.session.identities) || [];
    for (var i = 0; i < ids.length; i++) if (ids[i] && ids[i].name === name && ids[i].color) return ids[i].color;
    return '#ffffff';
}

function tick(t) {
    _raf = 0;
    if (!_target || _frame < 0) return;
    _cleared = false;
    (state.views || []).forEach(function (v) {
        var c = canvasFor(v);
        if (!c) return;
        var ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        var b = _boxes.get(v.name);
        if (!b) return;
        var toC = makeVideoToCanvasTransform(v.videoWidth, v.videoHeight, c.width, c.height);
        // Size lines, padding and text in SCREEN pixels: a tile shows the video at a fraction of its
        // size (and the wrapper's CSS scale adds zoom), so canvas px per screen px = width / (layout × zoom).
        var zs = v.zoom && v.zoom.scale ? v.zoom.scale : 1;
        var s = c.offsetWidth > 0 ? c.width / (c.offsetWidth * zs) : (toC.scale || 1), pad = 8 * s;
        var p0 = toC(b.x0, b.y0), p1 = toC(b.x1, b.y1);
        var x = p0.x - pad, y = p0.y - pad, w = (p1.x - p0.x) + 2 * pad, h = (p1.y - p0.y) + 2 * pad;
        var pulse = 0.75 + 0.25 * Math.sin(t / 220);
        ctx.save();
        ctx.lineWidth = 4 * s; ctx.strokeStyle = 'rgba(0, 0, 0, ' + (0.55 * pulse).toFixed(3) + ')';
        ctx.setLineDash([]); ctx.strokeRect(x, y, w, h);                          // dark halo: readable on any video
        ctx.lineWidth = 2.5 * s; ctx.strokeStyle = 'rgba(255, 176, 32, ' + pulse.toFixed(3) + ')';
        ctx.setLineDash([10 * s, 7 * s]); ctx.lineDashOffset = -((t / 28) % (17 * s));   // marching ants
        ctx.strokeRect(x, y, w, h);
        // "id_a ↔ id_b" above the box, each name in its identity's colour
        var fs = Math.round(13 * s), ly = Math.max(fs + 2 * s, y - 5 * s);
        ctx.setLineDash([]); ctx.font = '600 ' + fs + 'px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
        var parts = [[_target.nameA, colorOf(_target.nameA)], [' ↔ ', '#ffffff'], [_target.nameB, colorOf(_target.nameB)]];
        var tw = parts.reduce(function (a, p) { return a + ctx.measureText(p[0]).width; }, 0);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(x, ly - fs, tw + 8 * s, fs + 5 * s);
        var lx = x + 4 * s;
        parts.forEach(function (p) { ctx.fillStyle = p[1]; ctx.fillText(p[0], lx, ly); lx += ctx.measureText(p[0]).width; });
        ctx.restore();
    });
    if (typeof requestAnimationFrame === 'function') _raf = requestAnimationFrame(tick);
}
