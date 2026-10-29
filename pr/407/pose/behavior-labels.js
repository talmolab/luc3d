// pose/behavior-labels.js — labelled behavior bouts, per session.
//
// A bout says that one animal did (present) or explicitly did not (absent) do
// one ethogram behavior over a run of frames, optionally TO a target animal
// (social behaviors). Frames nobody labelled are unlabelled, which is not the
// same as absent: a classifier trains only on labelled frames, and "Mark
// reviewed" is how a range becomes absent where nothing was coded.
//
// ## Storage
//
// Per session (a WeakMap, so the Session class is untouched and an evicted
// lazy session keeps its labels), one sorted list of non-overlapping intervals
// per (behavior id, animal NAME, target NAME):
//
//   { start, end,            // frames, inclusive; a point event has start === end
//     present: true|false,
//     source: 'm'|'a'|'i',   // manual | accepted prediction | imported
//     note: '' }
//
// Animals are identity NAMES, not ids: ids are renumbered when a file is
// reopened, names are what a reopened project still agrees on (the same choice
// as the ID-switch review, ui/id-switch-review.js). Renaming an identity and
// swapping two identities over a range therefore rewrite the bouts too
// (`renameAnimal`, `swapAnimalsInRange`, called from Rename Identity and
// `Session.swapIdentitiesInRange`).
//
// Interval objects are never mutated once stored — every edit builds new
// lists — so an undo snapshot is just the previous list references.
//
// ## Running states
//
// Label Behaviors mode starts a state with its key and stops it with the same
// key (ui/behavior-mode.js). Until it is stopped it is a running entry
// `{behaviorId, animal, target, start}`; nothing writes a half-open bout.
// `closeRunning` ends every running state (leaving the mode, switching
// session), and a save writes them as ending at the session's cursor (the
// playhead, kept by `setBehaviorCursor`) without stopping them.
//
// DOM-free: Node tests import it directly.
//
// Depends on: pose/behavior-ethogram.js, pose/pose-data.js (the identity-swap hook)

import { behaviorById, exclusivePeers } from './behavior-ethogram.js?v=79abc800b879';
import { onIdentitySwap } from './pose-data.js?v=79abc800b879';

var SEP = '\u0001';
var UNDO_CAP = 100;
var SOURCES = ['m', 'a', 'i'];

var _stores = new WeakMap();
var _listeners = [];

function keyOf(behaviorId, animal, target) {
    return behaviorId + SEP + animal + SEP + (target || '');
}

function splitKey(k) {
    var p = k.split(SEP);
    return { behaviorId: p[0], animal: p[1], target: p[2] || '' };
}

function storeOf(session) {
    if (!session) return null;
    var st = _stores.get(session);
    if (!st) {
        st = { bouts: new Map(), running: new Map(), undo: [], redo: [], cursor: 0, fps: 0 };
        _stores.set(session, st);
    }
    return st;
}

/**
 * Be told after every change to a session's bouts (UI repaint, `markDirty`).
 * Loading a file does not notify.
 * @param {function(Session, Object)} fn
 */
export function onBehaviorChange(fn) {
    if (typeof fn === 'function') _listeners.push(fn);
}

function emit(session, info) {
    for (var i = 0; i < _listeners.length; i++) {
        try { _listeners[i](session, info || {}); } catch (e) { console.error('[behavior] listener failed', e); }
    }
}

function frameInt(f) {
    var n = Math.round(Number(f));
    return Number.isFinite(n) && n >= 0 ? n : null;
}

// ----------------------------------------------------------------------------
// Interval-list primitives. All return NEW arrays.
// ----------------------------------------------------------------------------

/** `list` with [start, end] cut out of every interval. */
function carve(list, start, end) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var iv = list[i];
        if (iv.end < start || iv.start > end) { out.push(iv); continue; }
        if (iv.start < start) out.push(Object.assign({}, iv, { end: start - 1 }));
        if (iv.end > end) out.push(Object.assign({}, iv, { start: end + 1 }));
    }
    return out;
}

function byStart(a, b) { return a.start - b.start || a.end - b.end; }

/**
 * Sort, then merge touching intervals that say the same thing (presence,
 * source, and no conflicting notes). Two present POINT events never merge —
 * frames 10 and 11 are two jumps — but absent runs of a point behavior do.
 */
function tidy(list, isPoint) {
    list.sort(byStart);
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var iv = list[i];
        var last = out.length ? out[out.length - 1] : null;
        if (last && last.end + 1 >= iv.start && last.present === iv.present && last.source === iv.source &&
            (!last.note || !iv.note || last.note === iv.note) && !(isPoint && iv.present)) {
            out[out.length - 1] = Object.assign({}, last, { end: Math.max(last.end, iv.end), note: last.note || iv.note });
        } else {
            out.push(iv);
        }
    }
    return out;
}

function setList(st, key, list) {
    if (list && list.length) st.bouts.set(key, list);
    else st.bouts.delete(key);
}

function isPointKey(key) {
    var b = behaviorById(splitKey(key).behaviorId);
    return !!(b && b.kind === 'point');
}

/** Write [start, end] into `key`, overwriting whatever that key said there. No undo, no notify. */
function writeInterval(st, key, start, end, present, source, note) {
    var list = carve(st.bouts.get(key) || [], start, end);
    list.push({ start: start, end: end, present: !!present, source: SOURCES.indexOf(source) >= 0 ? source : 'm', note: note || '' });
    setList(st, key, tidy(list, isPointKey(key)));
}

/**
 * Exclusive groups: where `key`'s behavior is now present on [start, end], the
 * animal's other behaviors in the same group are absent there.
 */
function clearPeersPresent(st, key, start, end) {
    var k = splitKey(key);
    var b = behaviorById(k.behaviorId);
    exclusivePeers(b).forEach(function (p) {
        peerKeys(st, p.id, k.animal).forEach(function (pk) {
            var list = st.bouts.get(pk) || [];
            var hit = list.filter(function (iv) { return iv.present && iv.end >= start && iv.start <= end; });
            if (!hit.length) return;
            var next = list;
            hit.forEach(function (iv) {
                var s = Math.max(iv.start, start), e = Math.min(iv.end, end);
                next = carve(next, s, e);
                next.push({ start: s, end: e, present: false, source: iv.source, note: '' });
            });
            setList(st, pk, tidy(next, isPointKey(pk)));
        });
    });
}

/** Every stored or running key of behavior `behaviorId` for `animal` (any target). */
function peerKeys(st, behaviorId, animal) {
    var prefix = behaviorId + SEP + animal + SEP;
    var out = [];
    st.bouts.forEach(function (_, k) { if (k.indexOf(prefix) === 0) out.push(k); });
    st.running.forEach(function (_, k) { if (k.indexOf(prefix) === 0 && out.indexOf(k) < 0) out.push(k); });
    return out;
}

/** The keys an edit of `key` to present may touch: itself and its exclusive peers. */
function affectedKeys(st, key, present) {
    var keys = [key];
    if (!present) return keys;
    var k = splitKey(key);
    exclusivePeers(behaviorById(k.behaviorId)).forEach(function (p) {
        peerKeys(st, p.id, k.animal).forEach(function (pk) { if (keys.indexOf(pk) < 0) keys.push(pk); });
    });
    return keys;
}

// ----------------------------------------------------------------------------
// Undo
// ----------------------------------------------------------------------------

function snapshot(st, keys) {
    return keys.map(function (k) { return [k, st.bouts.get(k) || null, st.running.get(k) || null]; });
}

function pushUndo(st, keys) {
    st.undo.push(snapshot(st, keys));
    if (st.undo.length > UNDO_CAP) st.undo.shift();
    st.redo.length = 0;
}

function restore(st, snap) {
    var inverse = snapshot(st, snap.map(function (s) { return s[0]; }));
    snap.forEach(function (s) {
        setList(st, s[0], s[1]);
        if (s[2]) st.running.set(s[0], s[2]); else st.running.delete(s[0]);
    });
    return inverse;
}

/** Undo the session's last behavior edit. @returns {boolean} whether there was one */
export function undoBehaviorEdit(session) {
    var st = storeOf(session);
    var snap = st && st.undo.pop();
    if (!snap) return false;
    st.redo.push(restore(st, snap));
    emit(session, { undo: true });
    return true;
}

/** Redo the last undone behavior edit. @returns {boolean} */
export function redoBehaviorEdit(session) {
    var st = storeOf(session);
    var snap = st && st.redo.pop();
    if (!snap) return false;
    st.undo.push(restore(st, snap));
    emit(session, { redo: true });
    return true;
}

export function canUndoBehaviorEdit(session) { var st = storeOf(session); return !!(st && st.undo.length); }
export function canRedoBehaviorEdit(session) { var st = storeOf(session); return !!(st && st.redo.length); }

// ----------------------------------------------------------------------------
// Edits
// ----------------------------------------------------------------------------

/** The target a bout of `b` is stored under: '' unless the behavior is social. */
function targetFor(b, target) {
    return b && b.social ? (typeof target === 'string' ? target : '') : '';
}

/**
 * Label frames [start, end] (inclusive, either order) of `animal` as
 * present or absent for a behavior, replacing whatever that animal's labels
 * for it (and that target) said there. Present labels in an exclusive group
 * turn the animal's other group behaviors absent on the same frames.
 *
 * @param {Session} session
 * @param {string} behaviorId
 * @param {string} animal identity name
 * @param {string} target identity name ('' for a non-social behavior; required for a social one)
 * @param {number} start
 * @param {number} end
 * @param {boolean} present
 * @param {{source?: string, note?: string}} [opts]
 * @returns {{start:number, end:number}|null} null when nothing could be labelled
 */
export function labelRange(session, behaviorId, animal, target, start, end, present, opts) {
    var st = storeOf(session);
    var b = behaviorById(behaviorId);
    var s = frameInt(start), e = frameInt(end);
    if (!st || !b || !animal || s == null || e == null) return null;
    if (s > e) { var t = s; s = e; e = t; }
    if (b.kind === 'point' && present) e = s;                      // a point event is one frame
    var tgt = targetFor(b, target);
    if (b.social && (!tgt || tgt === animal)) return null;
    var key = keyOf(b.id, animal, tgt);
    pushUndo(st, affectedKeys(st, key, present));
    writeInterval(st, key, s, e, present, (opts && opts.source) || 'm', opts && opts.note);
    if (present) clearPeersPresent(st, key, s, e);
    emit(session, { edit: 'label' });
    return { start: s, end: e };
}

/** Remove every label of one behavior/animal/target on [start, end] (they become unlabelled). */
export function clearRange(session, behaviorId, animal, target, start, end) {
    var st = storeOf(session);
    var b = behaviorById(behaviorId);
    var s = frameInt(start), e = frameInt(end);
    if (!st || !b || !animal || s == null || e == null) return false;
    if (s > e) { var t = s; s = e; e = t; }
    var key = keyOf(b.id, animal, targetFor(b, target));
    if (!st.bouts.has(key)) return false;
    pushUndo(st, [key]);
    setList(st, key, carve(st.bouts.get(key), s, e));
    emit(session, { edit: 'clear' });
    return true;
}

/**
 * Code a behavior at `frame`, as its key does in Label Behaviors mode: a point
 * behavior is labelled on that frame; a state starts there, or — when it is
 * already running for this animal and target — stops there and becomes a
 * present bout. Starting a state stops the animal's running states in the same
 * exclusive group on the frame before.
 *
 * @returns {{point?:Object, started?:boolean, stopped?:boolean, start?:number, end?:number}|null}
 */
export function toggleState(session, behaviorId, animal, target, frame) {
    var st = storeOf(session);
    var b = behaviorById(behaviorId);
    var f = frameInt(frame);
    if (!st || !b || !animal || f == null) return null;
    if (b.kind === 'point') {
        var p = labelRange(session, behaviorId, animal, target, f, f, true);
        return p ? { point: p } : null;
    }
    var tgt = targetFor(b, target);
    if (b.social && (!tgt || tgt === animal)) return null;
    var key = keyOf(b.id, animal, tgt);
    var run = st.running.get(key);
    if (run) {
        var s = Math.min(run.start, f), e = Math.max(run.start, f);
        pushUndo(st, affectedKeys(st, key, true));
        st.running.delete(key);
        writeInterval(st, key, s, e, true, 'm', '');
        clearPeersPresent(st, key, s, e);
        emit(session, { edit: 'stop' });
        return { stopped: true, start: s, end: e };
    }
    var stopping = [];
    exclusivePeers(b).forEach(function (pb) {
        st.running.forEach(function (r, rk) {
            if (r.behaviorId === pb.id && r.animal === animal) stopping.push(rk);
        });
    });
    pushUndo(st, [key].concat(stopping));
    stopping.forEach(function (rk) {
        var r = st.running.get(rk);
        st.running.delete(rk);
        if (f - 1 >= r.start) writeInterval(st, rk, r.start, f - 1, true, 'm', '');
    });
    st.running.set(key, { behaviorId: b.id, animal: animal, target: tgt, start: f });
    emit(session, { edit: 'start' });
    return { started: true, start: f };
}

/**
 * End every running state at `frame` (leaving Label Behaviors mode, switching
 * session). One undo step for all of them.
 * @returns {number} how many were running
 */
export function closeRunning(session, frame) {
    var st = storeOf(session);
    var f = frameInt(frame);
    if (!st || !st.running.size || f == null) return 0;
    var keys = Array.from(st.running.keys());
    pushUndo(st, keys);
    keys.forEach(function (k) {
        var r = st.running.get(k);
        st.running.delete(k);
        writeInterval(st, k, Math.min(r.start, f), Math.max(r.start, f), true, 'm', '');
    });
    emit(session, { edit: 'close' });
    return keys.length;
}

/** `closeRunning` at the session's cursor — where its playhead last was (a session switch). */
export function closeRunningAtCursor(session) {
    var st = session && _stores.get(session);
    return st ? closeRunning(session, st.cursor) : 0;
}

/** Drop a running state without writing it (Esc on a state started by mistake). */
export function cancelRunning(session, behaviorId, animal, target) {
    var st = storeOf(session);
    var b = behaviorById(behaviorId);
    if (!st || !b) return false;
    var key = keyOf(b.id, animal, targetFor(b, target));
    if (!st.running.has(key)) return false;
    pushUndo(st, [key]);
    st.running.delete(key);
    emit(session, { edit: 'cancel' });
    return true;
}

/**
 * Turn the unlabelled frames of [start, end] into absent labels, for each
 * behavior × animal (× every other animal as target, for a social behavior).
 * Frames already labelled either way are left alone.
 *
 * @param {string[]} behaviorIds
 * @param {string[]} animals the animals reviewed
 * @param {string[]} allAnimals every animal in the session (the possible targets)
 * @returns {number} frames that became absent
 */
export function markReviewed(session, behaviorIds, animals, allAnimals, start, end) {
    var st = storeOf(session);
    var s = frameInt(start), e = frameInt(end);
    if (!st || s == null || e == null) return 0;
    if (s > e) { var t = s; s = e; e = t; }
    var plan = [];
    (behaviorIds || []).forEach(function (bid) {
        var b = behaviorById(bid);
        if (!b) return;
        (animals || []).forEach(function (a) {
            var targets = b.social ? (allAnimals || []).filter(function (o) { return o !== a; }) : [''];
            targets.forEach(function (tg) { plan.push(keyOf(b.id, a, tg)); });
        });
    });
    if (!plan.length) return 0;
    pushUndo(st, plan);
    var filled = 0;
    plan.forEach(function (key) {
        var list = (st.bouts.get(key) || []).slice().sort(byStart);
        var gaps = [], cur = s;
        for (var i = 0; i < list.length && cur <= e; i++) {
            var iv = list[i];
            if (iv.end < cur) continue;
            if (iv.start > e) break;
            if (iv.start > cur) gaps.push([cur, iv.start - 1]);
            cur = Math.max(cur, iv.end + 1);
        }
        if (cur <= e) gaps.push([cur, e]);
        if (!gaps.length) return;
        gaps.forEach(function (g) {
            list.push({ start: g[0], end: g[1], present: false, source: 'm', note: '' });
            filled += g[1] - g[0] + 1;
        });
        setList(st, key, tidy(list, isPointKey(key)));
    });
    if (filled) emit(session, { edit: 'reviewed' });
    else st.undo.pop();
    return filled;
}

/** Delete one bout (as `listBouts` returned it). */
export function deleteBout(session, bout) {
    var st = storeOf(session);
    if (!st || !bout) return false;
    var key = keyOf(bout.behaviorId, bout.animal, bout.target);
    if (!st.bouts.has(key)) return false;
    pushUndo(st, [key]);
    setList(st, key, carve(st.bouts.get(key), bout.start, bout.end));
    emit(session, { edit: 'delete' });
    return true;
}

/**
 * Change one bout: its frames, behavior, animal, target, presence or note.
 * The edited bout overwrites whatever it now covers, like a fresh label.
 * @returns {{start:number,end:number}|null}
 */
export function editBout(session, bout, changes) {
    var st = storeOf(session);
    if (!st || !bout) return null;
    changes = changes || {};
    var next = {
        behaviorId: changes.behaviorId != null ? changes.behaviorId : bout.behaviorId,
        animal: changes.animal != null ? changes.animal : bout.animal,
        target: changes.target != null ? changes.target : bout.target,
        start: changes.start != null ? frameInt(changes.start) : bout.start,
        end: changes.end != null ? frameInt(changes.end) : bout.end,
        present: changes.present != null ? !!changes.present : bout.present,
        note: changes.note != null ? String(changes.note) : (bout.note || ''),
    };
    var b = behaviorById(next.behaviorId);
    if (!b || !next.animal || next.start == null || next.end == null) return null;
    if (next.start > next.end) { var t = next.start; next.start = next.end; next.end = t; }
    if (b.kind === 'point' && next.present) next.end = next.start;
    var tgt = targetFor(b, next.target);
    if (b.social && (!tgt || tgt === next.animal)) return null;
    var oldKey = keyOf(bout.behaviorId, bout.animal, bout.target);
    var newKey = keyOf(b.id, next.animal, tgt);
    var keys = affectedKeys(st, newKey, next.present);
    if (keys.indexOf(oldKey) < 0) keys.push(oldKey);
    pushUndo(st, keys);
    setList(st, oldKey, carve(st.bouts.get(oldKey) || [], bout.start, bout.end));
    writeInterval(st, newKey, next.start, next.end, next.present, bout.source || 'm', next.note);
    if (next.present) clearPeersPresent(st, newKey, next.start, next.end);
    emit(session, { edit: 'edit' });
    return { start: next.start, end: next.end };
}

/** Delete every bout (and running state) of a behavior. @returns {number} bouts removed */
export function deleteBehaviorBouts(session, behaviorId) {
    var st = storeOf(session);
    if (!st) return 0;
    var n = 0, keys = [];
    st.bouts.forEach(function (list, k) { if (splitKey(k).behaviorId === behaviorId) { keys.push(k); n += list.length; } });
    st.running.forEach(function (r, k) { if (r.behaviorId === behaviorId && keys.indexOf(k) < 0) keys.push(k); });
    if (!keys.length) return 0;
    pushUndo(st, keys);
    keys.forEach(function (k) { st.bouts.delete(k); st.running.delete(k); });
    emit(session, { edit: 'deleteBehavior' });
    return n;
}

// ----------------------------------------------------------------------------
// Identities
// ----------------------------------------------------------------------------

function rename(name, a, b) { return name === a ? b : name === b ? a : name; }

/**
 * An identity was renamed: its bouts (as actor and as target) follow. Clears
 * the behavior undo history, which still holds the old name.
 */
export function renameAnimal(session, oldName, newName) {
    var st = storeOf(session);
    if (!st || !oldName || !newName || oldName === newName) return 0;
    var moved = 0;
    var bouts = new Map();
    // Unmoved keys first, so a renamed animal's labels overwrite whatever an
    // orphan of the new name left on the same frames (never two overlapping
    // intervals in one list).
    var renamed = [];
    st.bouts.forEach(function (list, k) {
        var p = splitKey(k);
        var nk = keyOf(p.behaviorId, p.animal === oldName ? newName : p.animal, p.target === oldName ? newName : p.target);
        if (nk === k) bouts.set(k, list);
        else { renamed.push([nk, list]); moved += list.length; }
    });
    renamed.forEach(function (r) {
        var nk = r[0], merged = bouts.get(nk) || [];
        if (nk.split(SEP)[1] === nk.split(SEP)[2]) return;          // would target itself
        r[1].forEach(function (iv) { merged = carve(merged, iv.start, iv.end); merged.push(iv); });
        bouts.set(nk, tidy(merged, isPointKey(nk)));
    });
    var running = new Map();
    st.running.forEach(function (r) {
        var nr = Object.assign({}, r, { animal: r.animal === oldName ? newName : r.animal, target: r.target === oldName ? newName : r.target });
        running.set(keyOf(nr.behaviorId, nr.animal, nr.target), nr);
    });
    st.bouts = bouts; st.running = running; st.undo = []; st.redo = [];
    if (moved) emit(session, { identity: 'rename' });
    return moved;
}

/**
 * Two identities were exchanged on frames [start, end] (an ID-switch fix, or
 * an identity reassignment that swaps to the end of the timeline): the labels
 * on those frames belong to the swapped names, so they are exchanged too —
 * bouts that cross an edge are split there. Its own inverse, like the swap
 * that calls it. Clears the behavior undo history.
 *
 * @param {number} end inclusive; Infinity = to the end
 * @returns {number} intervals that moved
 */
export function swapAnimalsInRange(session, nameA, nameB, start, end) {
    var st = storeOf(session);
    if (!st || !nameA || !nameB || nameA === nameB || !(st.bouts.size || st.running.size)) return 0;
    var s = Math.max(0, Math.floor(start)), e = end;
    var moved = 0;
    var acc = new Map();
    var add = function (k, iv) { if (!acc.has(k)) acc.set(k, []); acc.get(k).push(iv); };
    st.bouts.forEach(function (list, k) {
        var p = splitKey(k);
        var sk = keyOf(p.behaviorId, rename(p.animal, nameA, nameB), rename(p.target, nameA, nameB));
        if (sk === k) { list.forEach(function (iv) { add(k, iv); }); return; }
        list.forEach(function (iv) {
            if (iv.end < s || iv.start > e) { add(k, iv); return; }
            if (iv.start < s) add(k, Object.assign({}, iv, { end: s - 1 }));
            if (iv.end > e) add(k, Object.assign({}, iv, { start: e + 1 }));
            add(sk, Object.assign({}, iv, { start: Math.max(iv.start, s), end: Math.min(iv.end, e) }));
            moved++;
        });
    });
    var bouts = new Map();
    acc.forEach(function (list, k) { setList({ bouts: bouts }, k, tidy(list, isPointKey(k))); });
    var running = new Map();
    st.running.forEach(function (r, k) {
        var inRange = r.start >= s && r.start <= e;
        var nr = inRange ? Object.assign({}, r, { animal: rename(r.animal, nameA, nameB), target: rename(r.target, nameA, nameB) }) : r;
        running.set(inRange ? keyOf(nr.behaviorId, nr.animal, nr.target) : k, nr);
    });
    st.bouts = bouts; st.running = running; st.undo = []; st.redo = [];
    if (moved) emit(session, { identity: 'swap' });
    return moved;
}

// Every `Session.swapIdentitiesInRange` carries the labels with the poses.
onIdentitySwap(swapAnimalsInRange);

/** Names that bouts mention (as animal or target) but `knownNames` does not — a deleted identity's labels. */
export function orphanedAnimals(session, knownNames) {
    var st = storeOf(session);
    var known = new Set(knownNames || []);
    var out = new Set();
    if (!st) return [];
    st.bouts.forEach(function (_, k) {
        var p = splitKey(k);
        if (!known.has(p.animal)) out.add(p.animal);
        if (p.target && !known.has(p.target)) out.add(p.target);
    });
    return Array.from(out).sort();
}

/** Reassign every bout of `fromName` (as animal and target) to `toName`, merging. */
export function reassignAnimal(session, fromName, toName) {
    var st = storeOf(session);
    if (!st || !fromName || !toName || fromName === toName) return 0;
    var keys = [];
    st.bouts.forEach(function (_, k) { var p = splitKey(k); if (p.animal === fromName || p.target === fromName) keys.push(k); });
    if (!keys.length) return 0;
    var n = 0;
    var dests = keys.map(function (k) {
        var p = splitKey(k);
        return keyOf(p.behaviorId, p.animal === fromName ? toName : p.animal, p.target === fromName ? toName : p.target);
    });
    pushUndo(st, keys.concat(dests.filter(function (d) { return keys.indexOf(d) < 0; })));
    keys.forEach(function (k, i) {
        var p = splitKey(dests[i]);
        if (p.target && p.target === p.animal) { st.bouts.delete(k); return; }   // would be a self-target
        var list = st.bouts.get(k);
        st.bouts.delete(k);
        n += list.length;
        var into = st.bouts.get(dests[i]) || [];
        var merged = into;
        list.forEach(function (iv) { merged = carve(merged, iv.start, iv.end); merged.push(iv); });
        setList(st, dests[i], tidy(merged, isPointKey(dests[i])));
    });
    emit(session, { edit: 'reassign' });
    return n;
}

// ----------------------------------------------------------------------------
// Queries
// ----------------------------------------------------------------------------

/** True when the session has any bout or running state. */
export function hasBehaviorData(session) {
    var st = session && _stores.get(session);
    return !!(st && (st.bouts.size || st.running.size));
}

/** One stored interval list (read-only, sorted), or []. */
export function boutIntervals(session, behaviorId, animal, target) {
    var st = session && _stores.get(session);
    return (st && st.bouts.get(keyOf(behaviorId, animal, target || ''))) || [];
}

/**
 * Every bout, as plain records sorted by start:
 * `{behaviorId, animal, target, start, end, present, source, note}`.
 * @param {{behaviorId?:string, animal?:string, present?:boolean}} [filter]
 */
export function listBouts(session, filter) {
    var st = session && _stores.get(session);
    if (!st) return [];
    filter = filter || {};
    var out = [];
    st.bouts.forEach(function (list, k) {
        var p = splitKey(k);
        if (filter.behaviorId != null && p.behaviorId !== filter.behaviorId) return;
        if (filter.animal != null && p.animal !== filter.animal) return;
        for (var i = 0; i < list.length; i++) {
            var iv = list[i];
            if (filter.present != null && iv.present !== filter.present) continue;
            out.push({ behaviorId: p.behaviorId, animal: p.animal, target: p.target, start: iv.start, end: iv.end,
                       present: iv.present, source: iv.source, note: iv.note });
        }
    });
    out.sort(function (a, b) { return a.start - b.start || a.end - b.end || (a.animal < b.animal ? -1 : a.animal > b.animal ? 1 : 0); });
    return out;
}

/** The running states: `[{behaviorId, animal, target, start}]`, oldest first. */
export function runningStates(session) {
    var st = session && _stores.get(session);
    if (!st) return [];
    return Array.from(st.running.values()).sort(function (a, b) { return a.start - b.start; });
}

/** Is this state running for this animal (and target)? */
export function isRunning(session, behaviorId, animal, target) {
    var st = session && _stores.get(session);
    var b = behaviorById(behaviorId);
    return !!(st && b && st.running.has(keyOf(b.id, animal, targetFor(b, target))));
}

function coversFrame(list, f) {
    var lo = 0, hi = list.length - 1;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1, iv = list[mid];
        if (f < iv.start) hi = mid - 1;
        else if (f > iv.end) lo = mid + 1;
        else return iv;
    }
    return null;
}

/**
 * What each animal is doing on `frame`: present bouts covering it, plus states
 * running since on or before it.
 * @returns {Array<{behaviorId:string, animal:string, target:string, running:boolean}>}
 */
export function activeAt(session, frame) {
    var st = session && _stores.get(session);
    if (!st) return [];
    var out = [];
    st.bouts.forEach(function (list, k) {
        var iv = coversFrame(list, frame);
        if (iv && iv.present) {
            var p = splitKey(k);
            out.push({ behaviorId: p.behaviorId, animal: p.animal, target: p.target, running: false });
        }
    });
    st.running.forEach(function (r) {
        if (frame >= r.start) out.push({ behaviorId: r.behaviorId, animal: r.animal, target: r.target, running: true });
    });
    return out;
}

/**
 * Per animal × behavior: present bouts and frames, absent frames.
 * @returns {Array<{animal, behaviorId, bouts, presentFrames, absentFrames}>}
 */
export function timeBudget(session) {
    var st = session && _stores.get(session);
    if (!st) return [];
    var rows = new Map();
    st.bouts.forEach(function (list, k) {
        var p = splitKey(k);
        var rk = p.animal + SEP + p.behaviorId;
        var r = rows.get(rk);
        if (!r) { r = { animal: p.animal, behaviorId: p.behaviorId, bouts: 0, presentFrames: 0, absentFrames: 0 }; rows.set(rk, r); }
        list.forEach(function (iv) {
            var n = iv.end - iv.start + 1;
            if (iv.present) { r.bouts++; r.presentFrames += n; } else r.absentFrames += n;
        });
    });
    return Array.from(rows.values());
}

/** How many bouts a behavior has in this session. */
export function countBehaviorBouts(session, behaviorId) {
    var st = session && _stores.get(session);
    if (!st) return 0;
    var n = 0;
    st.bouts.forEach(function (list, k) { if (splitKey(k).behaviorId === behaviorId) n += list.length; });
    return n;
}

// ----------------------------------------------------------------------------
// Cursor, fps, serialization
// ----------------------------------------------------------------------------

/** The playhead, so a save can write running states as ending there. */
export function setBehaviorCursor(session, frame) {
    var st = session && _stores.get(session);
    var f = frameInt(frame);
    if (st && f != null) st.cursor = f;
}

/** The frame rate labels were made at (recorded with them; frames stay the truth). */
export function noteBehaviorFps(session, fps) {
    var st = storeOf(session);
    if (st && fps > 0) st.fps = fps;
}

export function behaviorFps(session) {
    var st = session && _stores.get(session);
    return (st && st.fps) || 0;
}

/**
 * The bouts as saved rows, sorted:
 * `[behaviorId, animal, target, start, end, present (1|0), source, note]`.
 * Running states are written as present bouts ending at the cursor (they keep
 * running in memory).
 */
export function exportBoutRows(session) {
    var st = session && _stores.get(session);
    if (!st) return [];
    var bouts = st.bouts;
    if (st.running.size) {
        var copy = { bouts: new Map(st.bouts) };
        st.running.forEach(function (r, k) {
            var e = Math.max(r.start, st.cursor);
            var list = carve(copy.bouts.get(k) || [], r.start, e);
            list.push({ start: r.start, end: e, present: true, source: 'm', note: '' });
            setList(copy, k, tidy(list, isPointKey(k)));
        });
        bouts = copy.bouts;
    }
    var rows = [];
    bouts.forEach(function (list, k) {
        var p = splitKey(k);
        list.forEach(function (iv) {
            rows.push([p.behaviorId, p.animal, p.target, iv.start, iv.end, iv.present ? 1 : 0, iv.source, iv.note || '']);
        });
    });
    rows.sort(function (a, b) {
        return a[3] - b[3] || a[4] - b[4] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    });
    return rows;
}

/**
 * Replace the session's bouts with saved rows (a load). Rows naming a behavior
 * the ethogram does not have are dropped. Does not notify or mark dirty.
 *
 * @param {Array} rows as `exportBoutRows` writes them
 * @param {Map<string,string>} [idMap] file behavior id -> project id
 * @returns {{kept:number, dropped:number}}
 */
export function importBoutRows(session, rows, idMap) {
    var st = storeOf(session);
    if (!st) return { kept: 0, dropped: 0 };
    st.bouts = new Map(); st.running = new Map(); st.undo = []; st.redo = [];
    var kept = 0, dropped = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
        if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string' || !r[1]) { dropped++; return; }
        var bid = idMap && idMap.has(r[0]) ? idMap.get(r[0]) : r[0];
        var b = behaviorById(bid);
        var s = frameInt(r[3]), e = frameInt(r[4]);
        if (!b || s == null || e == null || e < s) { dropped++; return; }
        var tgt = targetFor(b, typeof r[2] === 'string' ? r[2] : '');
        if (b.social && (!tgt || tgt === r[1])) { dropped++; return; }
        writeInterval(st, keyOf(b.id, r[1], tgt), s, e, r[5] === 1 || r[5] === true, r[6], typeof r[7] === 'string' ? r[7] : '');
        kept++;
    });
    return { kept: kept, dropped: dropped };
}

/** Forget a session's bouts entirely (no undo). */
export function resetBehaviorLabels(session) {
    if (session) _stores.delete(session);
}
