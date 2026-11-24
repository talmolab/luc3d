// ui/outline-brush.js — the Outlines brush: correct an animal's outline by
// hand in a camera view. With the brush on (B, or the Outlines panel's Brush
// button), holding the LEFT button draws the animal's outline, holding the
// RIGHT button erases outline (any animal's) under the brush. The animal drawn
// is the one under the pointer where the stroke starts, else the one chosen in
// the Outlines panel (by default the last one drawn). [ and ] change the size,
// Cmd/Ctrl+Z undoes the last stroke, Esc puts the brush away.
//
// The first stroke on a camera frame copies the outline shown there into an
// edit (pose/outline-edits.js); from then on that camera frame shows the edit,
// which is saved with the project and exported as the corrected mask. While
// the brush is on, mouse buttons over a camera view paint instead of selecting
// or dragging poses; the wheel still zooms.
//
// Depends on: ui/app-state.js, ui/animal-outlines.js, ui/rendering.js
//             (`drawAllOverlays`), pose/outline-edits.js,
//             import-export/save-load.js (`markDirty`, `setStatus`)

import { state, interactionManager } from './app-state.js?v=25b9e152ca16';
import { drawnOutlines, setOutlinePaintHook, outlinesEnabled, entryLabels } from './animal-outlines.js?v=25b9e152ca16';
import { drawAllOverlays } from './rendering.js?v=25b9e152ca16';
import {
    BRUSH_MIN, BRUSH_MAX, beginOutlineEdit, outlineEditAt, paintSegment, pushStroke, undoStroke,
} from '../pose/outline-edits.js?v=25b9e152ca16';
import { markDirty, setStatus } from '../import-export/save-load.js?v=25b9e152ca16';

var PREFS_KEY = 'lucid.outlineBrush';

var brush = {
    on: false,
    radius: 8,              // video px
    animal: null,           // index chosen in the Outlines panel (null: the last one drawn / under the pointer)
    pointer: null,          // {view, x, y} in video px, while over a camera view
    stroke: null,           // {edit, value, last: [x, y], rec: {idx, old}}
};

try {
    var saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (saved && Number.isFinite(saved.radius)) brush.radius = clampRadius(saved.radius);
} catch (e) { /* storage off: defaults */ }

function clampRadius(r) { return Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(r))); }

function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ radius: brush.radius })); } catch (e) { /* best effort */ }
}

var _listeners = new Set();
function notify(what) { _listeners.forEach(function (fn) { try { fn(what || 'state'); } catch (e) { /* a panel gone */ } }); }
/** Call `fn(what)` when the brush turns on or off or changes animal ('state'), changes size ('radius'), or an edit changes ('edit'). -> unsubscribe */
export function onBrushChange(fn) { _listeners.add(fn); return function () { _listeners.delete(fn); }; }

/** The brush's state (read-only copy): {on, radius, animal}. */
export function brushState() { return { on: brush.on, radius: brush.radius, animal: brush.animal }; }

/** Brush size in video px (clamped to BRUSH_MIN..BRUSH_MAX). */
export function setBrushRadius(r) {
    brush.radius = clampRadius(r);
    savePrefs();
    notify('radius');
    redraw();
}

/** The animal (index in the view's outline) the brush draws when a stroke starts off every animal; null = the last drawn. */
export function setBrushAnimal(i) {
    brush.animal = Number.isInteger(i) && i >= 0 ? i : null;
    notify();
}

var _raf = 0;
function redraw() {
    if (_raf || typeof requestAnimationFrame === 'undefined') return;
    _raf = requestAnimationFrame(function () {
        _raf = 0;
        if (state.session) drawAllOverlays(state.currentFrame);
    });
}

function viewAt(target) {
    if (!target) return null;
    var views = state.views || [];
    for (var i = 0; i < views.length; i++) if (views[i].overlayCanvas === target) return views[i];
    return null;
}

function videoPoint(e, view) {
    if (interactionManager && interactionManager.canvasToVideo) return interactionManager.canvasToVideo(e.clientX, e.clientY, view.name);
    var r = view.overlayCanvas.getBoundingClientRect();
    return [(e.clientX - r.left) * view.videoWidth / r.width, (e.clientY - r.top) * view.videoHeight / r.height];
}

function onMouseDown(e) {
    if (!brush.on || (e.button !== 0 && e.button !== 2) || !outlinesEnabled()) return;   // hidden outlines: no blind painting
    var view = viewAt(e.target);
    if (!view || !state.session) return;
    e.preventDefault();
    e.stopPropagation();
    if (state.isPlaying) { setStatus('Pause to correct an outline'); return; }
    var frame = state.currentFrame;
    var shown = drawnOutlines(state.session, view.name);
    var edit = outlineEditAt(state.session, frame, view.name);
    if (!edit) {
        var labels = shown && shown.frame === frame ? entryLabels(shown) : null;
        if (!labels) {
            setStatus('The outline of ' + view.name + ' is not ready yet: try again in a moment');
            return;
        }
        edit = beginOutlineEdit(state.session, frame, view.name, shown.w, shown.h, labels, shown.animals);
    }
    var p = videoPoint(e, view);
    var value = 0;
    if (e.button === 0) {
        var xi = Math.floor(p[0]), yi = Math.floor(p[1]);
        var under = xi >= 0 && yi >= 0 && xi < edit.w && yi < edit.h ? edit.labels[yi * edit.w + xi] : 0;
        if (under > 0) value = under;
        else if (brush.animal != null && brush.animal < edit.animals.length) value = brush.animal + 1;
        else if (edit.animals.length === 1) value = 1;
        else {
            setStatus('Start the stroke on the animal, or choose which animal to draw in the Outlines panel');
            dropIfUntouched(edit);       // nothing painted yet: no edit
            return;
        }
        brush.animal = value - 1;
    }
    brush.stroke = { edit: edit, view: view.name, value: value, last: p, rec: { idx: [], old: [] } };
    if (paintSegment(edit.labels, edit.w, edit.h, p[0], p[1], p[0], p[1], brush.radius, value, brush.stroke.rec)) edit.version = (edit.version || 0) + 1;
    document.addEventListener('mousemove', onDragMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    redraw();
}

function dropIfUntouched(edit) {
    var m = state.session && state.session.outlineEdits;
    if (m && m.get && !edit.undo.length && !edit.version) {
        for (var [k, v] of m) if (v === edit) { m.delete(k); break; }
    }
}

function onDragMove(e) {
    var s = brush.stroke;
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    var view = (state.views || []).find(function (v) { return v.name === s.view; });
    if (!view) return;
    var p = videoPoint(e, view);
    brush.pointer = { view: view.name, x: p[0], y: p[1] };
    var n = paintSegment(s.edit.labels, s.edit.w, s.edit.h, s.last[0], s.last[1], p[0], p[1], brush.radius, s.value, s.rec);
    s.last = p;
    if (n) s.edit.version = (s.edit.version || 0) + 1;
    redraw();
}

function onMouseUp(e) {
    var s = brush.stroke;
    document.removeEventListener('mousemove', onDragMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    brush.stroke = null;
    if (s.rec.idx.length) {
        pushStroke(s.edit, s.rec);
        markDirty();
        setStatus((s.value ? 'Drew ' + (s.edit.animals[s.value - 1] && s.edit.animals[s.value - 1].name || 'the outline') : 'Erased outline') +
            ' in ' + s.edit.camera + ' (' + s.rec.idx.length.toLocaleString('en-US') + ' px). Cmd/Ctrl+Z undoes it.');
    } else {
        dropIfUntouched(s.edit);
    }
    notify('edit');
    redraw();
}

function onHover(e) {
    if (!brush.on || brush.stroke) return;
    var view = viewAt(e.target);
    var prev = brush.pointer;
    if (!view) {
        if (prev) { brush.pointer = null; redraw(); }
        return;
    }
    var p = videoPoint(e, view);
    brush.pointer = { view: view.name, x: p[0], y: p[1] };
    if (!prev || prev.view !== view.name) notify('state');   // the panel lists this view's animals
    redraw();
}

function onContextMenu(e) {
    if (brush.on && viewAt(e.target)) { e.preventDefault(); e.stopPropagation(); }
}

/** Undo the last stroke on the camera frame the pointer is over (else the last view used). -> whether one was undone */
export function undoBrushStroke() {
    var cam = (brush.pointer && brush.pointer.view) || (interactionManager && interactionManager.lastInteractedView);
    var edit = cam && state.session ? outlineEditAt(state.session, state.currentFrame, cam) : null;
    if (!edit || !undoStroke(edit)) { setStatus('Nothing to undo in this outline'); return false; }
    markDirty();
    notify('edit');
    redraw();
    setStatus('Undid a stroke in ' + cam + '’s outline');
    return true;
}

function onKey(e) {
    if (!brush.on) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault(); e.stopPropagation(); undoBrushStroke(); return;
    }
    if (e.key === '[' || e.key === ']') {
        e.preventDefault(); e.stopPropagation();
        var step = Math.max(1, Math.round(brush.radius * 0.2));
        setBrushRadius(brush.radius + (e.key === ']' ? step : -step));
        return;
    }
    if (e.key === 'Escape' && !document.querySelector('.multi-frame-modal-overlay')) {
        e.preventDefault(); e.stopPropagation(); setBrushOn(false);
    }
}

/** Draw the brush ring over the view the pointer is in (the outline paint hook). */
function paintCursor(view, frame, entry, opts) {
    if (!brush.on || !brush.pointer || brush.pointer.view !== view.name) return;
    var ctx = view.overlayCtx;
    var sx = ctx.canvas.width / (opts.videoWidth || entry.w), sy = ctx.canvas.height / (opts.videoHeight || entry.h);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.beginPath();
    ctx.arc(brush.pointer.x, brush.pointer.y, brush.radius, 0, Math.PI * 2);
    var lw = 1.5 * (opts.overlaySizeScale || 1) / Math.max(sx, 1e-6);
    ctx.lineWidth = lw * 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.stroke();
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.restore();
}

/** Turn the brush on or off (on also shows the outlines). */
export function setBrushOn(on) {
    on = !!on;
    if (brush.on === on) return;
    brush.on = on;
    if (on) {
        var cb = document.getElementById('visOutlines');
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('mousemove', onHover, true);
        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('keydown', onKey, true);
        setOutlinePaintHook(paintCursor);
        document.body.classList.add('outline-brush-on');
        setStatus('Outline brush: hold the left button to draw, the right to erase; [ ] size; Esc to stop');
    } else {
        document.removeEventListener('mousedown', onMouseDown, true);
        document.removeEventListener('mousemove', onHover, true);
        document.removeEventListener('contextmenu', onContextMenu, true);
        document.removeEventListener('keydown', onKey, true);
        setOutlinePaintHook(null);
        document.body.classList.remove('outline-brush-on');
        brush.pointer = null;
        brush.stroke = null;
    }
    notify();
    redraw();
}

/** B: the brush on / off. */
export function toggleOutlineBrush() { setBrushOn(!brush.on); }

/** Whether the outlines are showing with the brush on. */
export function outlineBrushActive() { return brush.on && outlinesEnabled(); }
