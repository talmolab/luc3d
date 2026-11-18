/**
 * ui/suggestions-panel.js — the Suggestions panel (`#tabSuggestions`, right-edge
 * rail): frames suggested for labelling, per camera view.
 *
 * A port of sleap-app's Suggestions panel (`src/components/panels/
 * SuggestionsPanel.tsx`: count pill, method, Per video, On Generate Add /
 * Replace, Target, Add labeled frames / Shuffle / Remove unlabeled, Limit to
 * frame range, Generate, a table, Add current frame / Remove / Clear all,
 * Prev / Next with "x/N labeled (%)"), changed for LUCID's multi-camera
 * sessions, where each camera view is one video:
 *   - Target is a radio pair, "All videos in session" or "Current video
 *     <camera>": the focused view (`interactionManager.lastInteractedView`,
 *     set by clicking a pane or the view strip).
 *   - The table is grouped by view. Each view with suggestions is a
 *     collapsible group whose header names the camera and shows its labeled
 *     count and bar; the focused view's group comes first, is tagged
 *     "current" and opens by itself. Prev / Next walk every group in that
 *     order and open the one they land in.
 *   - Replace swaps the Target's views only (sleap-app swaps the whole list),
 *     so "Current video" + Replace leaves the other views' suggestions alone.
 * Methods: Stride, Random, Frame chunk (the ones that need no predictions or
 * image features). Frame numbers are shown 1-based, like the frame readout.
 *
 * The list is the active session's `Session.suggestions` (`{camera, frameIdx,
 * group}`), saved in the `.slp` as SLEAP's `suggestions_json`
 * (`import-export/suggestions-io.js`); every edit marks the project dirty.
 * The logic is DOM-free in `pose/suggestions.js`. Which groups are open is not
 * remembered (it follows the focused view).
 *
 * The panel works only while it is on screen (`isPanelOnScreen`): it is
 * repainted by `refreshSuggestionsPanel`, called after each overlay redraw
 * (`ui/rendering.js`) and when the focused pane changes
 * (`ui/sessions-panes.js`), and once more when the rail shows it. During
 * playback only the row highlight moves. Its one scroller is the info panel:
 * the table grows (CLAUDE.md, one scroller per panel), and the groups fold.
 *
 * Seeking and focusing a view are handed in by `setupSuggestionsPanel`
 * (`pose/initialization.js`), like `setupPanelRail`'s `toggleInfoPanel`.
 */
import { state, interactionManager } from './app-state.js?v=bec6a5ed7502';
import { isPanelOnScreen, onPanelRailChange } from './panel-rail.js?v=bec6a5ed7502';
import { setStatus, markDirty } from '../import-export/save-load.js?v=bec6a5ed7502';
import { formatFrameNumber } from './frame-readout.js?v=bec6a5ed7502';
import { frameUserCountInView } from './frame-counters.js?v=bec6a5ed7502';
import { showPlaneDialog } from './plane-dialog.js?v=bec6a5ed7502';
import { isPlaneModeActive } from './plane-definition.js?v=bec6a5ed7502';
import {
    SUGGESTION_METHODS, DEFAULT_PER_VIDEO, mulberry32, generateSuggestions,
    mergeSuggestions, shuffleSuggestions, removeUnlabeledSuggestions, removeSuggestion,
    suggestionExists, labeledSummary, groupSuggestionsByView, stepSuggestion,
} from '../pose/suggestions.js?v=bec6a5ed7502';

const TAB = 'tabSuggestions';

let _els = null;
let _seek = null;
let _focusView = null;
/** Panel settings (sleap-app keeps them in component state: per page load). */
const _opts = {
    method: 'stride', perVideo: DEFAULT_PER_VIDEO, mode: 'add', target: 'all',
    range: false, rangeFrom: 1, rangeTo: 1000, chunkFrom: 1, chunkTo: 1000,
};
/** The selected row, `{camera, frameIdx}`, or null. */
let _selected = null;
/** Open groups (camera names). */
let _open = new Set();
/** The focused view and session at the last repaint, to open its group on a change. */
let _lastCurrent = null;
let _lastSession = null;
let _stale = true;
/**
 * Labeled / score per (camera, frame), so stepping does not re-read every row
 * (a store walk each on a lazy project). Kept across a seek, except for the
 * frame now on screen; dropped by a redraw of the SAME frame (an edit, or a
 * bulk operation, which ends by redrawing the frame on screen — the rule the
 * status-bar counters use, `ui/frame-counters.js`) and by any list change.
 */
let _cache = new Map();
let _cacheFrame = null;
let _cacheList = null;

// --------------------------------------------------------------------------
// The session and its views
// --------------------------------------------------------------------------

function session() { return state.session || null; }

function suggestions() {
    const s = session();
    return s && Array.isArray(s.suggestions) ? s.suggestions : [];
}

function setSuggestions(list) {
    const s = session();
    if (!s) return;
    s.suggestions = list;
    markDirty();
}

/** The session's view names, in the view strip's order. */
function viewNames() {
    const s = session();
    if (state.views && state.views.length) return state.views.map(function (v) { return v.name; });
    return s ? s.cameras.map(function (c) { return c.name; }) : [];
}

/** The focused view: the last pane clicked, else the first view. */
export function currentViewName() {
    const names = viewNames();
    const v = interactionManager ? interactionManager.lastInteractedView : null;
    if (v && names.indexOf(v) !== -1) return v;
    return names.length ? names[0] : null;
}

function viewFrameCount(name) {
    for (let i = 0; i < state.views.length; i++) {
        const d = state.views[i].name === name ? state.views[i].decoder : null;
        if (d && d.samples && d.samples.length) return d.samples.length;
    }
    const s = session();
    return state.totalFrames || (s && s.lazyLoader && s.lazyLoader.nFrames) || 0;
}

function videoFileName(name) {
    for (let i = 0; i < state.videoFiles.length; i++) {
        const vf = state.videoFiles[i];
        if (vf.assignedCamera === name) return vf.name || (vf.file && vf.file.name) || name;
    }
    return name;
}

/** True when `camera` has a user instance on `frameIdx`. */
function isLabeled(camera, frameIdx) {
    const s = session();
    return !!s && frameUserCountInView(s, camera, frameIdx) > 0;
}

/** `{labeled, score}` for one row, from `_cache` (see there). */
function rowInfo(camera, frameIdx) {
    const k = camera + '\u0000' + frameIdx;
    let v = _cache.get(k);
    if (!v) {
        v = { labeled: isLabeled(camera, frameIdx), score: null };
        _cache.set(k, v);
    }
    return v;
}

function rowScore(camera, frameIdx) {
    const v = rowInfo(camera, frameIdx);
    if (v.score === null) v.score = meanScore(camera, frameIdx);
    return v.score;
}

/** Drop what may be stale before a repaint (rules at `_cache`). */
function syncCache(list) {
    const f = state.currentFrame;
    if (list !== _cacheList || f === _cacheFrame) {
        _cache = new Map();
    } else {
        _cache.forEach(function (_, k) {
            if (Number(k.slice(k.indexOf('\u0000') + 1)) === f) _cache.delete(k);
        });
    }
    _cacheList = list;
    _cacheFrame = f;
}

/** Mean score of the predicted instances in one view-frame, or NaN. */
function meanScore(camera, frameIdx) {
    const s = session();
    if (!s) return NaN;
    let sum = 0, n = 0;
    const add = function (inst) {
        if (inst && inst.type === 'predicted' && Number.isFinite(inst.score)) { sum += inst.score; n++; }
    };
    const fg = s.frameGroups.get(frameIdx);
    if (fg) {
        (fg.instances.get(camera) || []).forEach(add);
        (fg.getUnlinkedInstances(camera) || []).forEach(function (u) { add(u.instance); });
    } else if (s.lazyLoader && typeof s.lazyLoader.forEachInstanceRow === 'function'
        && typeof s.lazyLoader.instanceScore === 'function') {
        const loader = s.lazyLoader;
        loader.forEachInstanceRow(function (cam, f, trk, info) {
            if (cam !== camera || f !== frameIdx || !info || info.type !== 'predicted') return;
            const sc = loader.instanceScore(cam, info.instanceRow);
            if (Number.isFinite(sc)) { sum += sc; n++; }
        }, { camera: camera, start: frameIdx, end: frameIdx + 1 });
    }
    return n ? sum / n : NaN;
}

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

function seekTo(row) {
    if (!row) return;
    _selected = { camera: row.camera, frameIdx: row.frameIdx };
    _open.add(row.camera);
    if (_focusView) _focusView(row.camera);
    if (_seek) _seek(row.frameIdx);
    refreshSuggestionsPanel({ force: true });
    scrollSelectedIntoView();
}

/** The rows in display order: every group, focused view first. */
function displayedRows() {
    const groups = groupSuggestionsByView(suggestions(), viewNames(), currentViewName());
    const out = [];
    groups.forEach(function (g) { g.rows.forEach(function (r) { out.push(r); }); });
    return out;
}

/** Prev (-1) / Next (+1) suggestion (also the `,` / `.` shortcuts). */
export function stepSuggestionNav(delta) {
    // Define Planes hides the rail and freezes the views; don't move them.
    if (isPlaneModeActive()) return;
    const rows = displayedRows();
    if (!rows.length) { setStatus('No suggestions', 'info'); return; }
    const here = { camera: currentViewName(), frameIdx: state.currentFrame };
    seekTo(stepSuggestion(rows, _selected, here, delta > 0 ? 1 : -1));
}

function generate() {
    const s = session();
    if (!s) { setStatus('No session', 'warning'); return; }
    const cur = currentViewName();
    const names = _opts.target === 'current' ? (cur ? [cur] : []) : viewNames();
    const views = names.map(function (n) { return { camera: n, nFrames: viewFrameCount(n) }; });
    if (_opts.method !== 'frame_chunk' && !(_opts.perVideo > 0)) {
        setStatus('Per video must be at least 1', 'warning');
        return;
    }
    const replace = _opts.mode === 'replace';
    const fresh = generateSuggestions(views, {
        method: _opts.method,
        perVideo: _opts.perVideo,
        range: _opts.range ? { from: _opts.rangeFrom, to: _opts.rangeTo } : null,
        chunk: { from: _opts.chunkFrom, to: _opts.chunkTo },
        rng: mulberry32((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0),
    }, replace ? [] : suggestions());
    const before = suggestions().length;
    // Replace swaps the Target's views only: with Target "Current video" the
    // other views keep their suggestions (sleap-app replaces the whole list,
    // but there every video is in its one flat table).
    const kept = replace ? suggestions().filter(function (s) { return names.indexOf(s.camera) === -1; }) : suggestions();
    const next = mergeSuggestions(kept, fresh);
    setSuggestions(next);
    _selected = null;
    if (cur) _open.add(cur);
    const added = replace ? fresh.length : next.length - before;
    const where = names.length === 1 ? names[0] : names.length.toLocaleString('en-US') + ' views';
    setStatus((replace ? 'Replaced with ' : 'Added ') + added.toLocaleString('en-US') + ' suggestion'
        + (added === 1 ? '' : 's') + ' (' + where + ')', added ? 'success' : 'info');
    refreshSuggestionsPanel({ force: true });
}

/** Every (view, frame) of the session with a user instance. */
function userLabeledViewFrames() {
    const s = session();
    if (!s) return [];
    const names = viewNames();
    const out = [];
    const seen = new Set();
    const push = function (cam, f) {
        const k = cam + '\u0000' + f;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ camera: cam, frameIdx: f, group: 0 });
    };
    const frames = Array.from(s.frameGroups.keys()).sort(function (a, b) { return a - b; });
    frames.forEach(function (f) {
        names.forEach(function (cam) { if (frameUserCountInView(s, cam, f) > 0) push(cam, f); });
    });
    const loader = s.lazyLoader;
    if (loader && typeof loader.forEachInstanceRow === 'function') {
        const candidates = [];
        loader.forEachInstanceRow(function (cam, f, trk, info) {
            if (s.frameGroups.has(f) || !info || info.type !== 'user') return;
            if (names.indexOf(cam) !== -1) candidates.push([cam, f]);
        });
        candidates.sort(function (a, b) { return a[1] - b[1]; });
        candidates.forEach(function (c) { if (frameUserCountInView(s, c[0], c[1]) > 0) push(c[0], c[1]); });
    }
    return out;
}

function addLabeledFrames() {
    const before = suggestions().length;
    const next = mergeSuggestions(suggestions(), userLabeledViewFrames());
    const added = next.length - before;
    if (added) setSuggestions(next);
    setStatus(added ? 'Added ' + added.toLocaleString('en-US') + ' labeled frame' + (added === 1 ? '' : 's')
        : 'Every labeled frame is already a suggestion', 'info');
    refreshSuggestionsPanel({ force: true });
}

function shuffle() {
    setSuggestions(shuffleSuggestions(suggestions(), mulberry32((Math.random() * 0x7fffffff) >>> 0)));
    setStatus('Shuffled suggestions', 'info');
    refreshSuggestionsPanel({ force: true });
}

function removeUnlabeled() {
    const before = suggestions().length;
    const next = removeUnlabeledSuggestions(suggestions(), isLabeled);
    const removed = before - next.length;
    if (removed) setSuggestions(next);
    if (_selected && !suggestionExists(next, _selected.camera, _selected.frameIdx)) _selected = null;
    setStatus(removed ? 'Removed ' + removed.toLocaleString('en-US') + ' unlabeled suggestion' + (removed === 1 ? '' : 's')
        : 'No unlabeled suggestions to remove', 'info');
    refreshSuggestionsPanel({ force: true });
}

function addCurrentFrame() {
    const cam = currentViewName();
    if (!session() || !cam) return;
    const f = state.currentFrame;
    if (suggestionExists(suggestions(), cam, f)) {
        setStatus('This frame is already a suggestion', 'info');
        return;
    }
    setSuggestions(suggestions().concat([{ camera: cam, frameIdx: f, group: 0 }]));
    _selected = { camera: cam, frameIdx: f };
    _open.add(cam);
    setStatus('Added ' + cam + ' frame ' + formatFrameNumber(f + 1) + ' as a suggestion', 'success');
    refreshSuggestionsPanel({ force: true });
}

function removeSelected() {
    if (!_selected) return;
    setSuggestions(removeSuggestion(suggestions(), _selected.camera, _selected.frameIdx));
    _selected = null;
    refreshSuggestionsPanel({ force: true });
}

function clearAll() {
    const n = suggestions().length;
    if (!n) return;
    showPlaneDialog({
        title: 'Clear suggestions',
        message: 'Remove all ' + n.toLocaleString('en-US') + ' suggestions from this session?',
        confirmLabel: 'Clear all',
        onConfirm: function () {
            setSuggestions([]);
            _selected = null;
            setStatus('Cleared all suggestions', 'info');
            refreshSuggestionsPanel({ force: true });
        },
    });
}

// --------------------------------------------------------------------------
// DOM
// --------------------------------------------------------------------------

function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) {
        Object.keys(props).forEach(function (k) {
            if (k === 'text') e.textContent = props[k];
            else if (k === 'className') e.className = props[k];
            else if (k === 'dataset') Object.assign(e.dataset, props[k]);
            else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
            else e.setAttribute(k, props[k]);
        });
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
}

function numberInput(id, value, label, onChange) {
    const input = el('input', { type: 'number', id: id, min: '1', step: '1', 'aria-label': label, className: 'sugg-num' });
    input.value = String(value);
    let last = value;
    input.addEventListener('change', function () {
        const v = parseInt(input.value, 10);
        if (Number.isFinite(v) && v >= 1) { last = v; onChange(v); }
        else input.value = String(last);
    });
    return input;
}

function build(pane) {
    pane.textContent = '';
    const els = {};
    const top = el('div', { className: 'info-section sugg-controls' });

    els.pill = el('span', { className: 'sugg-pill', id: 'suggCount' });
    top.appendChild(el('div', { className: 'sugg-row' }, [els.pill]));

    els.method = el('select', { id: 'suggMethod', 'aria-label': 'Suggestion method', className: 'sugg-select' });
    SUGGESTION_METHODS.forEach(function (m) {
        const o = el('option', { value: m.value, text: m.label });
        els.method.appendChild(o);
    });
    els.method.value = _opts.method;
    els.method.addEventListener('change', function () { _opts.method = els.method.value; syncControls(); });
    top.appendChild(els.method);

    els.perRow = el('div', { className: 'sugg-row' }, [
        el('span', { className: 'sugg-label', text: 'Per video' }),
        numberInput('suggPerVideo', _opts.perVideo, 'Per video', function (v) { _opts.perVideo = v; }),
    ]);
    top.appendChild(els.perRow);

    els.chunkRow = el('div', { className: 'sugg-row' }, [
        el('span', { className: 'sugg-label', text: 'From' }),
        numberInput('suggChunkFrom', _opts.chunkFrom, 'Frame chunk from', function (v) { _opts.chunkFrom = v; }),
        el('span', { className: 'sugg-label', text: 'To' }),
        numberInput('suggChunkTo', _opts.chunkTo, 'Frame chunk to', function (v) { _opts.chunkTo = v; }),
    ]);
    top.appendChild(els.chunkRow);

    els.btnAdd = el('button', { className: 'sugg-toggle', id: 'suggModeAdd', type: 'button', text: 'Add',
        title: 'Generate adds to the list', onclick: function () { _opts.mode = 'add'; syncControls(); } });
    els.btnReplace = el('button', { className: 'sugg-toggle', id: 'suggModeReplace', type: 'button', text: 'Replace',
        title: 'Generate replaces the list', onclick: function () { _opts.mode = 'replace'; syncControls(); } });
    top.appendChild(el('div', { className: 'sugg-row' }, [
        el('span', { className: 'sugg-label', text: 'On Generate' }), els.btnAdd, els.btnReplace,
    ]));

    // Target: a radio pair. "Current video" names the focused view.
    const radio = function (value, id) {
        const r = el('input', { type: 'radio', name: 'suggTarget', id: id, value: value });
        r.checked = _opts.target === value;
        r.addEventListener('change', function () { if (r.checked) { _opts.target = value; syncControls(); } });
        return r;
    };
    els.targetAll = radio('all', 'suggTargetAll');
    els.targetCurrent = radio('current', 'suggTargetCurrent');
    els.allCount = el('span', { className: 'sugg-hint', id: 'suggTargetAllCount' });
    els.currentName = el('span', { className: 'sugg-cam', id: 'suggTargetCurrentName' });
    top.appendChild(el('div', { className: 'sugg-row sugg-target', role: 'radiogroup', 'aria-label': 'Target videos' }, [
        el('span', { className: 'sugg-label', text: 'Target' }),
        el('div', { className: 'sugg-radios' }, [
            el('label', { for: 'suggTargetAll' }, [els.targetAll, 'All videos in session ', els.allCount]),
            el('label', { for: 'suggTargetCurrent', title: 'The focused camera view (click a pane to change it)' },
                [els.targetCurrent, 'Current video ', els.currentName]),
        ]),
    ]));

    els.btnAddLabeled = el('button', { className: 'panel-btn', id: 'suggAddLabeled', type: 'button',
        text: 'Add labeled frames', title: 'Add every view-frame with a user instance', onclick: addLabeledFrames });
    els.btnShuffle = el('button', { className: 'panel-btn', id: 'suggShuffle', type: 'button',
        text: 'Shuffle', title: 'Put the suggestions in random order', onclick: shuffle });
    els.btnRemoveUnlabeled = el('button', { className: 'panel-btn', id: 'suggRemoveUnlabeled', type: 'button',
        text: 'Remove unlabeled', title: 'Remove suggestions with no user instance in their view', onclick: removeUnlabeled });
    top.appendChild(el('div', { className: 'panel-button-row sugg-btns' }, [els.btnAddLabeled, els.btnShuffle, els.btnRemoveUnlabeled]));

    els.rangeOn = el('input', { type: 'checkbox', id: 'suggRangeOn' });
    els.rangeOn.checked = _opts.range;
    els.rangeOn.addEventListener('change', function () { _opts.range = els.rangeOn.checked; syncControls(); });
    els.rangeFrom = numberInput('suggRangeFrom', _opts.rangeFrom, 'Frame range from', function (v) { _opts.rangeFrom = v; });
    els.rangeTo = numberInput('suggRangeTo', _opts.rangeTo, 'Frame range to', function (v) { _opts.rangeTo = v; });
    top.appendChild(el('label', { className: 'sugg-check', for: 'suggRangeOn' }, [els.rangeOn, 'Limit to frame range']));
    els.rangeRow = el('div', { className: 'sugg-row' }, [
        el('span', { className: 'sugg-label', text: 'From' }), els.rangeFrom,
        el('span', { className: 'sugg-label', text: 'To' }), els.rangeTo,
    ]);
    top.appendChild(els.rangeRow);

    els.btnGenerate = el('button', { className: 'sugg-generate', id: 'suggGenerate', type: 'button',
        text: 'Generate Suggestions', onclick: generate });
    top.appendChild(els.btnGenerate);
    pane.appendChild(top);

    // The grouped table.
    const listSec = el('div', { className: 'info-section sugg-list' });
    els.groupTools = el('div', { className: 'sugg-row sugg-group-tools' }, [
        el('span', { className: 'sugg-hint', text: 'Current view first' }),
        el('button', { className: 'sugg-mini', id: 'suggExpandAll', type: 'button', text: 'Expand all',
            onclick: function () { viewGroupsCameras().forEach(function (c) { _open.add(c); }); refreshSuggestionsPanel({ force: true }); } }),
        el('button', { className: 'sugg-mini', id: 'suggCollapseAll', type: 'button', text: 'Collapse',
            onclick: function () { _open = new Set(); refreshSuggestionsPanel({ force: true }); } }),
    ]);
    listSec.appendChild(els.groupTools);
    els.table = el('table', { className: 'data-table sugg-table', id: 'suggTable' });
    els.table.appendChild(el('colgroup', null, [
        el('col'), el('col', { style: 'width:52px' }), el('col', { style: 'width:62px' }), el('col', { style: 'width:62px' }),
    ]));
    els.table.appendChild(el('thead', null, [el('tr', null, [
        el('th', { className: 'sugg-r', text: 'Frame' }),
        el('th', { className: 'sugg-r', text: 'Group' }),
        el('th', { className: 'sugg-c', text: 'Labeled' }),
        el('th', { className: 'sugg-r', text: 'Score', title: 'Mean score of the predicted instances in that view and frame' }),
    ])]));
    els.tbody = el('tbody');
    els.table.appendChild(els.tbody);
    els.table.addEventListener('click', onTableClick);
    listSec.appendChild(els.table);
    els.empty = el('div', { className: 'table-empty', id: 'suggEmpty',
        text: 'No suggestions yet. Click Generate Suggestions to create some.' });
    listSec.appendChild(els.empty);
    pane.appendChild(listSec);

    // Footer: edit row, then Prev / status / Next.
    const foot = el('div', { className: 'info-section sugg-foot' });
    els.btnAddCurrent = el('button', { className: 'panel-btn', id: 'suggAddCurrent', type: 'button',
        text: 'Add current frame', title: 'Suggest the frame on screen in the focused view', onclick: addCurrentFrame });
    els.btnRemove = el('button', { className: 'panel-btn', id: 'suggRemove', type: 'button',
        text: 'Remove', title: 'Remove the selected suggestion', onclick: removeSelected });
    els.btnClear = el('button', { className: 'panel-btn', id: 'suggClearAll', type: 'button',
        text: 'Clear all', onclick: clearAll });
    foot.appendChild(el('div', { className: 'panel-button-row sugg-btns' }, [els.btnAddCurrent, els.btnRemove, els.btnClear]));
    els.btnPrev = el('button', { className: 'panel-btn sugg-nav-btn', id: 'suggPrev', type: 'button',
        text: '◀ Prev', title: 'Previous suggestion (,)', onclick: function () { stepSuggestionNav(-1); } });
    els.btnNext = el('button', { className: 'panel-btn sugg-nav-btn', id: 'suggNext', type: 'button',
        text: 'Next ▶', title: 'Next suggestion (.)', onclick: function () { stepSuggestionNav(1); } });
    els.status = el('span', { className: 'sugg-status', id: 'suggStatus' });
    foot.appendChild(el('div', { className: 'sugg-nav' }, [els.btnPrev, els.status, els.btnNext]));
    pane.appendChild(foot);
    return els;
}

function viewGroupsCameras() {
    return groupSuggestionsByView(suggestions(), viewNames(), currentViewName()).map(function (g) { return g.camera; });
}

function onTableClick(e) {
    const head = e.target.closest('tr.sugg-group');
    if (head) {
        const cam = head.dataset.camera;
        if (_open.has(cam)) _open.delete(cam); else _open.add(cam);
        refreshSuggestionsPanel({ force: true });
        return;
    }
    const tr = e.target.closest('tr.sugg-item');
    if (!tr) return;
    seekTo({ camera: tr.dataset.camera, frameIdx: Number(tr.dataset.frame) });
}

/** Controls whose state does not depend on the list. */
function syncControls() {
    if (!_els) return;
    const chunk = _opts.method === 'frame_chunk';
    _els.perRow.hidden = chunk;
    _els.chunkRow.hidden = !chunk;
    _els.btnAdd.classList.toggle('on', _opts.mode === 'add');
    _els.btnAdd.setAttribute('aria-pressed', String(_opts.mode === 'add'));
    _els.btnReplace.classList.toggle('on', _opts.mode === 'replace');
    _els.btnReplace.setAttribute('aria-pressed', String(_opts.mode === 'replace'));
    _els.targetAll.checked = _opts.target === 'all';
    _els.targetCurrent.checked = _opts.target === 'current';
    _els.rangeRow.hidden = !_opts.range;
    const names = viewNames();
    const cur = currentViewName();
    _els.allCount.textContent = '(' + names.length.toLocaleString('en-US') + ')';
    _els.currentName.textContent = cur || '—';
    const hasSession = !!session() && names.length > 0;
    _els.btnGenerate.disabled = !hasSession;
    _els.btnAddLabeled.disabled = !hasSession;
    _els.btnAddCurrent.disabled = !hasSession;
}

function scrollSelectedIntoView() {
    if (!_els) return;
    const row = _els.tbody.querySelector('tr.selected');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

function isHere(r, cur) {
    return r.camera === cur && r.frameIdx === state.currentFrame;
}

function isSelected(r) {
    return !!_selected && _selected.camera === r.camera && _selected.frameIdx === r.frameIdx;
}

/** Full repaint of the list, counts and buttons. */
function render() {
    const list = suggestions();
    const cur = currentViewName();
    const s = session();
    if (s !== _lastSession) { _lastSession = s; _selected = null; _open = new Set(); _lastCurrent = null; }
    if (cur !== _lastCurrent) { if (cur) _open.add(cur); _lastCurrent = cur; }
    if (_selected && !suggestionExists(list, _selected.camera, _selected.frameIdx)) _selected = null;
    syncControls();

    syncCache(list);
    const labeled = function (cam, f) { return rowInfo(cam, f).labeled; };
    const total = list.length;
    _els.pill.textContent = total.toLocaleString('en-US') + ' suggestion' + (total === 1 ? '' : 's');

    const groups = groupSuggestionsByView(list, viewNames(), cur);
    const frag = document.createDocumentFragment();
    groups.forEach(function (g) {
        const open = _open.has(g.camera);
        const sum = labeledSummary(g.rows, labeled);
        const head = el('tr', { className: 'sugg-group' + (g.camera === cur ? ' sugg-current' : ''),
            dataset: { camera: g.camera }, 'aria-expanded': String(open), title: videoFileName(g.camera) });
        const td = el('td', { colspan: '4' });
        td.appendChild(el('span', { className: 'sugg-caret', text: open ? '▾' : '▸' }));
        td.appendChild(el('span', { className: 'sugg-camname', text: g.camera }));
        if (g.camera === cur) td.appendChild(el('span', { className: 'sugg-tag', text: 'current' }));
        td.appendChild(el('span', { className: 'sugg-group-count', text:
            sum.labeled.toLocaleString('en-US') + '/' + sum.total.toLocaleString('en-US') }));
        const bar = el('div', { className: 'sugg-bar' });
        const fill = el('i');
        fill.style.width = (sum.pct || 0).toFixed(1) + '%';
        bar.appendChild(fill);
        td.appendChild(bar);
        head.appendChild(td);
        frag.appendChild(head);
        if (!open) return;
        g.rows.forEach(function (r) {
            const sc = rowScore(r.camera, r.frameIdx);
            const cls = ['sugg-item'];
            if (isSelected(r)) cls.push('selected');
            if (isHere(r, cur)) cls.push('sugg-here');
            const tr = el('tr', { className: cls.join(' '), dataset: { camera: r.camera, frame: String(r.frameIdx) } });
            tr.appendChild(el('td', { className: 'sugg-r mono', text: formatFrameNumber(r.frameIdx + 1) }));
            tr.appendChild(el('td', { className: 'sugg-r mono sugg-dim', text: String(r.group != null ? r.group : 0) }));
            const lab = el('td', { className: 'sugg-c' });
            if (labeled(r.camera, r.frameIdx)) lab.appendChild(el('span', { className: 'sugg-dot', title: 'Has user labels' }));
            tr.appendChild(lab);
            tr.appendChild(el('td', { className: 'sugg-r mono sugg-dim', text: Number.isFinite(sc) ? sc.toFixed(2) : '--' }));
            frag.appendChild(tr);
        });
    });
    _els.tbody.textContent = '';
    _els.tbody.appendChild(frag);
    _els.table.hidden = total === 0;
    _els.groupTools.hidden = total === 0;
    _els.empty.hidden = total > 0;

    const all = labeledSummary(list, labeled);
    _els.status.textContent = total
        ? all.labeled.toLocaleString('en-US') + '/' + total.toLocaleString('en-US') + ' labeled (' + all.pct.toFixed(1) + '%)'
        : '';
    _els.btnShuffle.disabled = total === 0;
    _els.btnRemoveUnlabeled.disabled = total === 0;
    _els.btnClear.disabled = total === 0;
    _els.btnRemove.disabled = !_selected;
    _els.btnPrev.disabled = total === 0;
    _els.btnNext.disabled = total === 0;
    _stale = false;
}

/** Playback: move only the "on screen" highlight. */
function moveHighlight() {
    const cur = currentViewName();
    if (cur !== _lastCurrent) { render(); return; }
    const rows = _els.tbody.querySelectorAll('tr.sugg-item');
    for (let i = 0; i < rows.length; i++) {
        const tr = rows[i];
        tr.classList.toggle('sugg-here', tr.dataset.camera === cur && Number(tr.dataset.frame) === state.currentFrame);
    }
}

/**
 * Repaint the panel if it is on screen, else mark it stale for when it is.
 * Called after every overlay redraw and on a focused-pane change.
 * @param {{force?: boolean}} [opts] - `force`: a full repaint even mid-playback
 */
export function refreshSuggestionsPanel(opts) {
    if (!_els) return;
    if (!isPanelOnScreen(TAB)) { _stale = true; return; }
    if (state.isPlaying && !_stale && !(opts && opts.force)) { moveHighlight(); return; }
    render();
}

/**
 * Build the panel into `#tabSuggestions`.
 * @param {{seekToFrame: function(number), focusView: function(string)}} deps
 */
export function setupSuggestionsPanel(deps) {
    const pane = document.getElementById(TAB);
    if (!pane) return;
    _seek = deps && deps.seekToFrame;
    _focusView = deps && deps.focusView;
    _els = build(pane);
    syncControls();
    onPanelRailChange(function () { if (_stale) refreshSuggestionsPanel(); });
    refreshSuggestionsPanel();
}
