// ui/behavior-timeline.js — behavior labels on the timeline: the "Behavior"
// row group (one row per animal, see `Timeline.setBehaviorRowsProvider`) and
// the menu a Shift+drag range opens to label that range.
//
// A row shows the behavior selected in the Behavior tab, or — with none
// selected — every behavior that has bouts, as thin stacked lanes. Present
// bouts are drawn in the behavior's color, explicit "not" labels as a faint
// gray (that is what was reviewed), and a running state grows to the playhead.
// Projects with no ethogram and no bouts get no Behavior group at all.
//
// Depends on: ui/app-state.js, ui/behavior-coding.js, pose/behavior-ethogram.js,
//             pose/behavior-labels.js, import-export/save-load.js

import { state, timeline } from './app-state.js?v=79abc800b879';
import {
    sessionAnimals, focalAnimal, selectedBehaviorId, codeBehavior, armRange, clearBehaviorRange,
    registerBehaviorRepaint, animalColor,
} from './behavior-coding.js?v=79abc800b879';
import { behaviors, behaviorById } from '../pose/behavior-ethogram.js?v=79abc800b879';
import { listBouts, runningStates, hasBehaviorData, orphanedAnimals } from '../pose/behavior-labels.js?v=79abc800b879';
import { setStatus } from '../import-export/save-load.js?v=79abc800b879';

/** Color of explicit "not this behavior" labels. */
export var ABSENT_COLOR = '#9aa0a6';
var MAX_LANES = 5;                       // 10 px rows: lanes stay >= 2 px

/**
 * The behavior rows for `session`, or null when it has nothing to show.
 * @returns {Array<{animal:string, color:string, lanes:number, segments:Array}>|null}
 */
export function behaviorTimelineRows(session) {
    if (!session) return null;
    if (!behaviors().length && !hasBehaviorData(session)) return null;
    var animals = sessionAnimals(session);
    var names = animals.concat(orphanedAnimals(session, animals));
    if (!names.length) return null;
    var bouts = listBouts(session);
    var running = runningStates(session);
    var sel = selectedBehaviorId();
    var shown;
    if (sel) {
        shown = [sel];
    } else {
        var used = new Set();
        bouts.forEach(function (b) { used.add(b.behaviorId); });
        running.forEach(function (r) { used.add(r.behaviorId); });
        shown = behaviors().filter(function (b) { return used.has(b.id); }).map(function (b) { return b.id; });
    }
    var laneOf = new Map();
    shown.forEach(function (id, i) { laneOf.set(id, i % MAX_LANES); });
    var lanes = Math.max(1, Math.min(MAX_LANES, shown.length));
    var byAnimal = new Map(names.map(function (n) { return [n, []]; }));
    bouts.forEach(function (bt) {
        if (!laneOf.has(bt.behaviorId) || !byAnimal.has(bt.animal)) return;
        var b = behaviorById(bt.behaviorId);
        byAnimal.get(bt.animal).push({
            start: bt.start, end: bt.end, lane: laneOf.get(bt.behaviorId),
            color: bt.present ? b.color : ABSENT_COLOR, alpha: bt.present ? 0.85 : 0.22,
        });
    });
    var cursor = state.currentFrame;
    running.forEach(function (r) {
        var b = behaviorById(r.behaviorId);
        if (!b || !laneOf.has(r.behaviorId) || !byAnimal.has(r.animal)) return;
        byAnimal.get(r.animal).push({ start: r.start, end: Math.max(r.start, cursor), lane: laneOf.get(r.behaviorId), color: b.color, alpha: 1 });
    });
    return names.map(function (n) {
        return { animal: n, color: animalColor(session, n), lanes: lanes, segments: byAnimal.get(n) };
    });
}

// Repaint the rows after any label or selection change, and every frame while
// a state runs (its bar grows with the playhead).
registerBehaviorRepaint(function (info) {
    if (!timeline) return;
    if (info.frame && !info.labels && !info.ui && !info.ethogram && !runningStates(state.session).length) return;
    timeline.refreshBehaviorRows();
});

// ----------------------------------------------------------------------------
// The Shift+drag menu
// ----------------------------------------------------------------------------

var _menu = null;

function closeRangeMenu() {
    if (!_menu) return;
    _menu.remove();
    _menu = null;
    document.removeEventListener('keydown', onMenuKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    if (timeline) timeline.clearRangeSelection();
}

function onMenuKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeRangeMenu();
}

function onOutside(e) {
    if (_menu && !_menu.contains(e.target)) closeRangeMenu();
}

function frameRangeText(start, end) {
    var n = end - start + 1;
    var fps = state.fps > 0 ? state.fps : 30;
    return 'Frames ' + (start + 1).toLocaleString('en-US') + '–' + (end + 1).toLocaleString('en-US') +
        ' · ' + n.toLocaleString('en-US') + ' frame' + (n === 1 ? '' : 's') + ' (' + (n / fps).toFixed(1) + ' s)';
}

/**
 * The timeline's `onRangeSelect`: with an ethogram and animals, open the menu
 * that labels the range; otherwise just report it, as before.
 * @param {number} start
 * @param {number} end
 * @param {{animal?:string}} [info] the behavior row the drag started on
 */
export function onTimelineRangeSelect(start, end, info) {
    var session = state.session;
    if (!session || !behaviors().length || !sessionAnimals(session).length) {
        setStatus('Selected range: ' + start.toLocaleString('en-US') + '–' + end.toLocaleString('en-US'));
        return;
    }
    showRangeMenu(start, end, (info && info.animal) || focalAnimal(session));
}

function showRangeMenu(start, end, animal) {
    closeRangeMenu();
    var session = state.session;
    var menu = document.createElement('div');
    menu.className = 'behavior-range-menu';
    menu.id = 'behaviorRangeMenu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Label this range');

    var head = document.createElement('div');
    head.className = 'behavior-range-head';
    head.textContent = frameRangeText(start, end);
    menu.appendChild(head);

    var animals = sessionAnimals(session);
    var pick = document.createElement('select');
    pick.className = 'behavior-range-animal';
    animals.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n; o.textContent = n;
        if (n === animal) o.selected = true;
        pick.appendChild(o);
    });
    var who = document.createElement('label');
    who.className = 'behavior-range-who';
    who.textContent = 'Animal ';
    who.appendChild(pick);
    menu.appendChild(who);

    var grid = document.createElement('div');
    grid.className = 'behavior-range-buttons';
    behaviors().forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'behavior-chip-btn';
        btn.dataset.behavior = b.id;
        btn.title = 'Label the range "' + b.name + '" — Shift-click: label it "not ' + b.name + '"';
        var sw = document.createElement('span');
        sw.className = 'behavior-swatch';
        sw.style.background = b.color;
        btn.appendChild(sw);
        btn.appendChild(document.createTextNode(b.name + (b.key ? ' (' + b.key + ')' : '')));
        btn.addEventListener('click', function (e) {
            var a = pick.value;
            closeRangeMenu();
            codeBehavior(b.id, { animal: a, start: start, end: end, absent: e.shiftKey });
        });
        grid.appendChild(btn);
    });
    menu.appendChild(grid);

    var actions = document.createElement('div');
    actions.className = 'behavior-range-actions';
    var arm = document.createElement('button');
    arm.className = 'panel-btn';
    arm.textContent = 'Use as [ ] range';
    arm.title = 'Keep this range armed: the next behavior key labels it';
    arm.addEventListener('click', function () { closeRangeMenu(); armRange(start, end); setStatus(frameRangeText(start, end) + ' armed — a behavior key labels it'); });
    var clear = document.createElement('button');
    clear.className = 'panel-btn';
    clear.textContent = 'Clear labels';
    clear.title = 'Remove every behavior label of this animal in the range';
    clear.addEventListener('click', function () {
        var a = pick.value;
        closeRangeMenu();
        var n = clearBehaviorRange(session, a, start, end);
        setStatus(n ? 'Cleared behavior labels of ' + a + ' in the range' : 'No behavior labels of ' + a + ' in the range');
    });
    var close = document.createElement('button');
    close.className = 'panel-btn';
    close.textContent = 'Close';
    close.addEventListener('click', closeRangeMenu);
    actions.appendChild(arm);
    actions.appendChild(clear);
    actions.appendChild(close);
    menu.appendChild(actions);

    document.body.appendChild(menu);
    _menu = menu;
    // Above the timeline, near the end of the selection, kept on screen.
    var canvas = timeline && timeline._canvas;
    var rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: window.innerHeight - 120 };
    var x = canvas ? rect.left + timeline._frameToX(end + 1) : window.innerWidth / 2;
    var w = menu.offsetWidth || 320;
    menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + 'px';
    menu.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + 'px';
    document.addEventListener('keydown', onMenuKey, true);
    document.addEventListener('mousedown', onOutside, true);
}
