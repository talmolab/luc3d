// ui/behavior-mode.js — Label Behaviors mode: walk through a session and code
// the ethogram's behaviors with single keys.
//
// Enter and leave ONLY through `toggleBehaviorMode` (Behavior menu, the
// toolbar's Behavior button, Mod+Shift+L), which does the unwinding: leaving
// closes running states at the playhead, so a bout is never left half-open.
// Defining Plane Mode and this mode exclude each other — entering one leaves
// the other.
//
// While on, a capture-phase keydown listener takes these keys before every
// other handler (and only these):
//
//   a behavior's letter   start / stop that state (or code that point) for the
//                         focal animal at the playhead; with a range armed,
//                         label the range (Shift + letter: label it "not")
//   1–9                   pick the focal animal (instead of assigning an
//                         identity), or the target a social behavior waits for
//   [  /  ]               arm a range: its start / its end at the playhead
//   ,  /  .               previous / next bout (focal animal, selected behavior)
//   Mod+Z / Mod+Shift+Z   undo / redo behavior edits
//   Esc                   cancel the target question or the armed range;
//                         otherwise leave the mode
//
// Everything else — Space, the arrows, speed, zoom, other letters — falls
// through, so playback and proofreading work as usual. Outside the mode the
// Behavior tab's buttons and the timeline's Shift+drag menu still label.
//
// Depends on: ui/app-state.js, ui/behavior-coding.js, ui/keyboard-target.js,
//             ui/plane-definition.js, pose/behavior-ethogram.js,
//             pose/behavior-labels.js, import-export/save-load.js

import { state } from './app-state.js?v=79abc800b879';
import {
    behaviorUi, codeBehavior, pickBehaviorTarget, cancelPendingTarget, setFocalAnimal, sessionAnimals,
    focalAnimal, setRangeIn, setRangeOut, clearArmedRange, armedRange, adjacentBout, goToBehaviorFrame,
    openBehaviorTab, requestBehaviorRepaint, registerBehaviorRepaint,
} from './behavior-coding.js?v=79abc800b879';
import { shouldIgnoreShortcut } from './keyboard-target.js?v=79abc800b879';
import { isPlaneModeActive, exitPlaneMode } from './plane-definition.js?v=79abc800b879';
import { behaviorByKey, behaviorById, behaviors } from '../pose/behavior-ethogram.js?v=79abc800b879';
import { closeRunning, runningStates, undoBehaviorEdit, redoBehaviorEdit } from '../pose/behavior-labels.js?v=79abc800b879';
import { setStatus } from '../import-export/save-load.js?v=79abc800b879';

var _active = false;

export function isBehaviorModeActive() {
    return _active;
}

export function enterBehaviorMode() {
    if (_active) return;
    if (isPlaneModeActive()) exitPlaneMode();
    _active = true;
    document.body.classList.add('behavior-mode');
    var bar = document.getElementById('behaviorModeBar');
    if (bar) bar.style.display = '';
    document.addEventListener('keydown', onKey, true);
    openBehaviorTab();
    syncToolbarButton();
    requestBehaviorRepaint({ ui: true });
    setStatus(behaviors().length
        ? 'Label Behaviors mode — behavior keys code the focal animal, 1–9 pick it, Esc leaves'
        : 'Label Behaviors mode — add behaviors first (Edit Ethogram… in the Behavior tab)', 'success');
}

export function exitBehaviorMode() {
    if (!_active) return;
    _active = false;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('behavior-mode');
    var bar = document.getElementById('behaviorModeBar');
    if (bar) bar.style.display = 'none';
    cancelPendingTarget();
    clearArmedRange();
    var closed = closeRunning(state.session, state.currentFrame);
    syncToolbarButton();
    requestBehaviorRepaint({ ui: true });
    setStatus(closed ? 'Left Label Behaviors mode — ' + closed + ' running behavior' + (closed === 1 ? '' : 's') +
        ' ended at this frame' : 'Left Label Behaviors mode', 'success');
}

export function toggleBehaviorMode() {
    if (_active) exitBehaviorMode();
    else enterBehaviorMode();
}

function syncToolbarButton() {
    var btn = document.getElementById('tbBehaviorMode');
    if (btn) {
        btn.classList.toggle('active', _active);
        btn.setAttribute('aria-pressed', _active ? 'true' : 'false');
    }
}

/** Is a dialog up? The mode's keys must not reach the app behind it. */
function modalOpen() {
    return !!document.querySelector('.plane-confirm-overlay, .multi-frame-modal-overlay, .behavior-modal-overlay');
}

function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
}

function onKey(e) {
    if (!_active || shouldIgnoreShortcut(e) || modalOpen()) return;
    var session = state.session;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        consume(e);
        var did = e.shiftKey ? redoBehaviorEdit(session) : undoBehaviorEdit(session);
        setStatus(did ? (e.shiftKey ? 'Redid the last behavior edit' : 'Undid the last behavior edit')
            : (e.shiftKey ? 'Nothing to redo' : 'No behavior edit to undo'));
        return;
    }
    if (mod) return;
    // `[ ] , .` are matched by the character they type, which some layouts
    // reach with Option / AltGr (German Mac: Option+5 is "["), so Alt is
    // allowed for them and only for them.
    if (e.key === '[') { consume(e); setRangeIn(state.currentFrame); return; }
    if (e.key === ']') { consume(e); setRangeOut(state.currentFrame); return; }
    if (e.key === ',' || e.key === '.') {
        consume(e);
        var bout = adjacentBout(session, state.currentFrame, e.key === '.' ? 1 : -1);
        if (bout) goToBehaviorFrame(bout.start);
        else setStatus(e.key === '.' ? 'No later bout' : 'No earlier bout');
        return;
    }
    if (e.altKey) return;
    if (e.key === 'Escape') {
        consume(e);
        if (cancelPendingTarget()) return;
        if (behaviorUi().rangeIn != null) { clearArmedRange(); setStatus('Range cleared'); return; }
        exitBehaviorMode();
        return;
    }
    if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
        consume(e);
        var names = sessionAnimals(session);
        var name = names[parseInt(e.key, 10) - 1];
        if (!name) { setStatus('There is no animal ' + e.key + ' (' + names.length + ' identit' + (names.length === 1 ? 'y' : 'ies') + ')', 'warning'); return; }
        if (!pickBehaviorTarget(name)) {
            setFocalAnimal(name);
            setStatus('Labelling ' + name);
        }
        return;
    }
    if (!/^[a-z]$/i.test(e.key)) return;
    var b = behaviorByKey(e.key);
    if (!b) return;
    // Shift + letter labels an armed range "not"; without a range it is not
    // ours (Shift+G groups, Shift+T tracks a frame…).
    if (e.shiftKey && !armedRange()) return;
    consume(e);
    codeBehavior(b.id, { absent: e.shiftKey });
}

// ----------------------------------------------------------------------------
// The mode bar: focal animal, running states (with how long), armed range,
// and the target question.
// ----------------------------------------------------------------------------

function fmtSeconds(frames) {
    var fps = state.fps > 0 ? state.fps : 30;
    return (frames / fps).toFixed(1) + ' s';
}

function renderBar() {
    var hint = document.getElementById('behaviorModeHint');
    if (!hint || !_active) return;
    var session = state.session;
    var parts = [];
    var focal = focalAnimal(session);
    parts.push(focal ? 'Animal: ' + focal : 'No animals yet');
    var ui = behaviorUi();
    if (ui.pending) {
        var pb = behaviorById(ui.pending.behaviorId);
        parts.push('Target of ' + (pb ? pb.name : '?') + '? press 1–9');
    }
    runningStates(session).forEach(function (r) {
        var b = behaviorById(r.behaviorId);
        if (!b) return;
        parts.push('● ' + b.name + ' · ' + r.animal + (r.target ? ' → ' + r.target : '') + ' ' +
            fmtSeconds(Math.max(0, state.currentFrame - r.start + 1)));
    });
    if (ui.rangeIn != null) {
        parts.push('Range ' + (ui.rangeIn + 1).toLocaleString('en-US') + '–' +
            (ui.rangeOut != null ? (ui.rangeOut + 1).toLocaleString('en-US') : '…'));
    }
    hint.textContent = parts.join('   ·   ');
}

registerBehaviorRepaint(renderBar);
