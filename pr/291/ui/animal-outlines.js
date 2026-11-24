// ui/animal-outlines.js — Visibility ▸ Animal Outlines: an outline per camera
// and animal, built the idtracker.ai way (pose/outline-core.js) and drawn
// behind the skeletons in every camera view.
//
// Per camera, once per session: frames sampled across the video at its
// keyframes (one decode each) give the empty arena (per-pixel median) and the
// single-animal area model (`ensureBackgrounds`). Per camera frame shown while
// paused: the frame (`decoder.peekFrame`, a cache hit for the frame on screen)
// and every animal's pose in that camera go to a worker
// (pose/outline-worker.js); the outlines come back and the overlay redraws. One
// request per camera at a time, the newest wins; results are cached by camera,
// frame and the poses they were made from, so an edit to a pose recomputes.
// During playback only cached outlines draw (nothing is computed).
//
// An animal here is an instance group on the frame (its own 2D detection in
// this camera, else its 3D projected into it: `groupReprojection`) or an
// ungrouped detection in this camera. Its colour is the skeleton's
// (`getGroupColor` / `unlinkedBaseColor`), never computed separately.
//
// Depends on: ui/app-state.js, ui/overlays.js, ui/image-embedder.js
//             (`keyframeIndices`), ui/rendering.js (`drawAllOverlays`, circular:
//             used in function bodies only), ui/loading-overlay.js,
//             pose/pose-data.js (`groupDisplayName`), pose/outline-core.js,
//             pose/outline-worker.js (`handleOutlineMessage`, the inline path)

import { state, isViewDocked } from './app-state.js?v=29f895d644eb';
import { groupReprojection, getGroupColor, unlinkedBaseColor, unlinkedDupIndices } from './overlays.js?v=29f895d644eb';
import { keyframeIndices } from './image-embedder.js?v=29f895d644eb';
import { drawAllOverlays } from './rendering.js?v=29f895d644eb';
import { showLoadingProgress, hideLoading } from './loading-overlay.js?v=29f895d644eb';
import { ensureLazyFrameData } from '../pose/triangulation.js?v=29f895d644eb';
import { groupDisplayName } from '../pose/pose-data.js?v=29f895d644eb';
import { cagePlanes, mirroredPoint, reflectionVisible } from '../pose/cage-mirrors.js?v=29f895d644eb';
import { tailChain, animalFromInstance, areaModel, poseAreaModel, outlineParams, pointInPolygon, labelImageContours, keypointCheck, outlineSuspects } from '../pose/outline-core.js?v=29f895d644eb';
import { outlineEditAt, rleEncode, rleDecode } from '../pose/outline-edits.js?v=29f895d644eb';
import { handleOutlineMessage } from '../pose/outline-worker.js?v=29f895d644eb';

/** Frames sampled per camera for its empty arena (odd: an exact median). */
export var BACKGROUND_FRAMES = 39;
/** Camera frames whose outlines are kept (8 cameras x 8 frames). */
export var OUTLINE_CACHE_SIZE = 64;
/** A camera frame's outline request is given up after this long (ms). */
export var JOB_TIMEOUT_MS = 30000;
/** px: a keypoint this close to its animal's outline is on it. */
export var KEYPOINT_REACH = 3;

// ---------------------------------------------------------------------------
// Settings (browser-local display taste: the Visibility tab's controls)
// ---------------------------------------------------------------------------

/** Whether Visibility ▸ Animal Outlines ▸ Show is on. */
export function outlinesEnabled() {
    var el = typeof document !== 'undefined' && document.getElementById('visOutlines');
    return !!(el && el.checked);
}

function fillAlpha() {
    var el = typeof document !== 'undefined' && document.getElementById('visOutlineFill');
    var v = el ? parseFloat(el.value) : 25;
    return isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 0.25;
}

/** The outline parameters in force (the defaults; `window.LUCID_OUTLINE_PARAMS` overrides for tests). */
export function currentOutlineParams() {
    return outlineParams(typeof window !== 'undefined' ? window.LUCID_OUTLINE_PARAMS : null);
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

var _pool = null;

function makePool() {
    var inline = typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
        !!(typeof window !== 'undefined' && window.LUCID_OUTLINE_INLINE);
    var size = inline ? 1 : Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
    var pool = { inline: inline, workers: [], camWorker: new Map(), next: 0, seq: 0, pending: new Map(), store: { bgs: new Map() } };
    if (!inline) {
        for (var i = 0; i < size; i++) {
            try {
                var w = new Worker(new URL('../pose/outline-worker.js?v=29f895d644eb', import.meta.url), { type: 'module' });
                w.onmessage = onWorkerMessage;
                w.onerror = onWorkerError(i);
                pool.workers.push(w);
            } catch (e) {
                pool.inline = true;
                break;
            }
        }
    }
    return pool;
}

function pool() {
    if (!_pool) _pool = makePool();
    return _pool;
}

function onWorkerMessage(e) {
    var msg = e.data || {};
    var p = _pool && _pool.pending.get(msg.id);
    if (!p) return;
    _pool.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
}

function onWorkerError(i) {
    return function (e) {
        // A worker that fails to load (or dies) fails everything it was given;
        // the next build runs inline.
        if (!_pool) return;
        _pool.pending.forEach(function (p, id) { if (p.worker === i) { p.reject(new Error(e.message || 'outline worker failed')); _pool.pending.delete(id); } });
        _pool.inline = true;
    };
}

function inlineCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
}

/** Send `msg` for camera key `cam` to its worker (the same one every time). -> reply */
function call(cam, msg, transfer) {
    var P = pool();
    if (P.inline) {
        return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
            return handleOutlineMessage(msg, P.store, inlineCanvas).reply;
        });
    }
    var wi = P.camWorker.get(cam);
    if (wi == null) { wi = P.next++ % P.workers.length; P.camWorker.set(cam, wi); }
    var id = ++P.seq;
    msg.id = id;
    return new Promise(function (resolve, reject) {
        P.pending.set(id, { resolve: resolve, reject: reject, worker: wi });
        P.workers[wi].postMessage(msg, transfer || []);
    });
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

var _sessions = new WeakMap();
var _sessionSeq = 0;

function sessionState(session) {
    var st = _sessions.get(session);
    if (!st) {
        st = { id: ++_sessionSeq, cams: new Map(), cache: new Map(), want: new Map(), busy: new Set(), lastDrawn: new Map(), building: null };
        _sessions.set(session, st);
    }
    return st;
}

function camKey(st, cam) { return st.id + '|' + cam; }

/** A camera's empty-arena state: {status, w, h, bg, model, areas, singles, frames, nAnimals, error, decoder}. */
export function outlineCameraState(session, cam) {
    return session ? sessionState(session).cams.get(cam) || null : null;
}

/** Forget a session's empty arenas and outlines (e.g. its videos changed). */
export function resetOutlines(session) {
    if (!session) return;
    var st = _sessions.get(session);
    if (!st) return;
    st.cams.forEach(function (c, cam) { if (_pool && !_pool.inline) call(camKey(st, cam), { type: 'drop', cam: camKey(st, cam) }).catch(function () {}); });
    _sessions.delete(session);
}

/** The number of animals the area model counts blobs against. */
export function outlineAnimalCount(session, cam, frameIdx) {
    var n = session && session.numAnimals;
    if (Number.isInteger(n) && n >= 1) return n;
    var groups = session && session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    var fg = session && session.getFrameGroup ? session.getFrameGroup(frameIdx) : null;
    var k = animalsInView(session, frameIdx, cam, groups || [], fg).length;
    return k >= 1 ? k : null;
}

// ---------------------------------------------------------------------------
// Animals in a view
// ---------------------------------------------------------------------------

var _chainCache = { key: '', chain: null };

function skeletonChain(skeleton) {
    var nodes = skeleton && skeleton.nodes ? skeleton.nodes : [];
    var edges = skeleton && skeleton.edges ? skeleton.edges : [];
    var key = nodes.join('\u0001') + '|' + edges.map(function (e) { return e[0] + '-' + e[1]; }).join(',');
    if (_chainCache.key !== key) _chainCache = { key: key, chain: tailChain(nodes, edges) };
    return _chainCache.chain;
}

function anyPoint(inst) {
    if (!inst) return false;
    for (var k = 0; k < inst.numNodes; k++) if (inst.hasPoint(k)) return true;
    return false;
}

function cameraOf(session, name) {
    var cams = session && session.cameras ? session.cameras : [];
    for (var i = 0; i < cams.length; i++) if (cams[i].name === name) return cams[i];
    return null;
}

/**
 * An animal's 3D body projected into `camera`, for the outline's 3D limit
 * (`tubeReach`, pose/outline-core.js): per body edge with both ends in 3D, its
 * two image points (distortion included) and the image scale at each
 * (pixels per calibration unit: a step across the view at 1 % of the depth,
 * projected); body nodes alone when the skeleton has no body edge. And how far
 * the animal's 2D body keypoints lie from their projections (`inst2d`; median
 * px, 0 without a 2D pose). -> {tubes, tubeError} or null without 3D.
 */
export function bodyTubes(group, camera, edges, chain, inst2d) {
    var p3 = group && group.points3d;
    var proj = scaledProjector(camera);
    if (!p3 || !p3.length || !proj) return null;
    var n = (p3.length / 3) | 0;
    var memo = [];
    var at = function (k) {
        if (memo[k] !== undefined) return memo[k];
        var X = k >= 0 && k < n ? [p3[3 * k], p3[3 * k + 1], p3[3 * k + 2]] : null;
        memo[k] = X && isFinite(X[0]) && isFinite(X[1]) && isFinite(X[2]) ? proj(X) : null;
        return memo[k];
    };
    var T = edgeTubes(at, n, edges, chain);
    if (!T.length) return null;
    var err = 0;
    if (inst2d) {
        var ds = [];
        for (var j = 0; j < n; j++) {
            if (chain.isTail[j] || !at(j) || !inst2d.hasPoint(j)) continue;
            var x = inst2d.getX(j), y = inst2d.getY(j);
            if (isFinite(x) && isFinite(y)) ds.push(Math.hypot(x - at(j)[0], y - at(j)[1]));
        }
        ds.sort(function (a, b) { return a - b; });
        err = ds.length ? ds[ds.length >> 1] : Infinity;
    }
    return { tubes: T, tubeError: err };
}

// Projects a 3D point into `camera` with the image scale there: [u, v,
// pixels per calibration unit] (a step across the view at 1 % of the depth,
// projected, distortion included), or null behind the camera. null without
// a calibrated camera.
function scaledProjector(camera) {
    if (!camera || typeof camera.project !== 'function' || !camera.rotationMatrix || !camera.tvec) return null;
    var R = camera.rotationMatrix, t = camera.tvec;
    var pr = function (X) { var uv = camera.project(X); return camera.distortPoint ? camera.distortPoint(uv) : uv; };
    return function (X) {
        var z = R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2];
        if (!(z > 0)) return null;
        var uv = pr(X), d = 0.01 * z;
        var uv2 = pr([X[0] + d * R[0][0], X[1] + d * R[0][1], X[2] + d * R[0][2]]);
        var sc = Math.hypot(uv2[0] - uv[0], uv2[1] - uv[1]) / d;
        return isFinite(uv[0]) && isFinite(uv[1]) && sc > 0 && isFinite(sc) ? [uv[0], uv[1], sc] : null;
    };
}

// Body edges (no tail node) with both ends projected (`at(k)`: [u, v, scale]
// or null) as tubes; body nodes alone when no body edge has both.
function edgeTubes(at, n, edges, chain) {
    var T = [];
    (edges || []).forEach(function (e) {
        var u = e[0], v = e[1];
        if (chain.isTail[u] || chain.isTail[v]) return;
        var a = at(u), b = at(v);
        if (a && b) T.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    });
    if (!T.length) for (var k = 0; k < n; k++) { if (chain.isTail[k]) continue; var q = at(k); if (q) T.push(q[0], q[1], q[2], q[0], q[1], q[2]); }
    return T;
}

var _cagePlanes = { cage: null, planes: [] };

/**
 * An animal's mirror images in the arena's floor and walls (a campy cage,
 * `session.campyCage`, pose/cage-mirrors.js) as `camera` would see them: per
 * surface, the body mirrored across it and projected (tubes as `bodyTubes`'),
 * only the edges whose both ends' images the camera sees through that
 * surface's own rectangle. -> [{plane (index in `cagePlanes`), tubes}] (only
 * surfaces with an edge seen), or null without a cage, 3D or calibration.
 */
export function bodyMirrors(group, camera, edges, chain, cage) {
    var p3 = group && group.points3d;
    var proj = scaledProjector(camera);
    if (!cage || !p3 || !p3.length || !proj) return null;
    if (_cagePlanes.cage !== cage) _cagePlanes = { cage: cage, planes: cagePlanes(cage) };
    var planes = _cagePlanes.planes;
    var R = camera.rotationMatrix, t = camera.tvec;
    var C = [0, 1, 2].map(function (i) { return -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]); });   // -R^T t
    var n = (p3.length / 3) | 0, out = [];
    planes.forEach(function (pl, j) {
        var memo = [];
        var at = function (k) {
            if (memo[k] !== undefined) return memo[k];
            var r = null;
            if (k >= 0 && k < n) {
                var X = [p3[3 * k], p3[3 * k + 1], p3[3 * k + 2]];
                if (isFinite(X[0]) && isFinite(X[1]) && isFinite(X[2])) {
                    var Xm = mirroredPoint(X, pl);
                    if (reflectionVisible(C, X, Xm, pl)) r = proj(Xm);
                }
            }
            memo[k] = r;
            return r;
        };
        var T = [];
        (edges || []).forEach(function (e) {
            if (chain.isTail[e[0]] || chain.isTail[e[1]]) return;
            var a = at(e[0]), b = at(e[1]);
            if (a && b) T.push(a[0], a[1], a[2], b[0], b[1], b[2]);
        });
        if (T.length) out.push({ plane: j, tubes: T });
    });
    return out;
}

function resolveIdentity(session, group, inst, cam, frameIdx) {
    if (inst && Number.isInteger(inst.trackIdx) && inst.trackIdx >= 0 && session.getIdentityForTrack) {
        var ident = session.getIdentityForTrack(inst.trackIdx, cam, frameIdx);
        if (ident && ident.id != null) return ident.id;
    }
    if (group && group.identityId != null && group.identityId >= 0) return group.identityId;
    return null;
}

// mean distance between two instances' shared points (Infinity: none shared)
function meanGap(a, b) {
    var n = Math.min(a.numNodes, b.numNodes), s = 0, c = 0;
    for (var k = 0; k < n; k++) {
        if (!a.hasPoint(k) || !b.hasPoint(k)) continue;
        s += Math.hypot(a.getX(k) - b.getX(k), a.getY(k) - b.getY(k)); c++;
    }
    return c ? s / c : Infinity;
}

/**
 * The animals in camera `cam` at `frameIdx`, in a fixed order: the frame's
 * instance groups (their own detection here, else their 3D projected), then
 * the ungrouped detections here (a prediction duplicating a user instance of
 * the same track, or lying on one, is left out). Each:
 * `{body, segments, tail, name, color, identity, track, source, ref}`.
 */
export function animalsInView(session, frameIdx, cam, groups, frameGroup) {
    if (!session) return [];
    var skel = session.skeleton;
    var edges = skel && skel.edges ? skel.edges : [];
    var chain = skeletonChain(skel);
    var useId = !!state.colorByIdentity;
    var out = [];
    var camera = cameraOf(session, cam);
    var placed = [];
    (groups || []).forEach(function (g) {
        var inst = g.instances && g.instances.get ? g.instances.get(cam) : null;
        var source = '2d';
        if (!anyPoint(inst)) { inst = groupReprojection(g, cam, camera); source = '3d'; }
        if (!inst) return;
        var a = animalFromInstance(inst, edges, chain);
        if (!a.body.length) return;
        if (source === '2d') placed.push(inst);
        var tb = bodyTubes(g, camera, edges, chain, source === '2d' ? inst : null);
        if (tb) {
            a.tubes = tb.tubes; a.tubeError = tb.tubeError;
            if (session.campyCage) a.mirrors = bodyMirrors(g, camera, edges, chain, session.campyCage);
        }
        a.name = groupDisplayName(session, g, frameIdx);
        a.color = getGroupColor(g, session, useId, frameIdx, cam) || '#cccccc';
        a.identity = resolveIdentity(session, g, source === '2d' ? inst : null, cam, frameIdx);
        a.track = source === '2d' && Number.isInteger(inst.trackIdx) && inst.trackIdx >= 0 ? inst.trackIdx : null;
        a.source = source;
        a.ref = { kind: 'group', id: g.id };
        out.push(a);
    });
    var unl = frameGroup && frameGroup.getUnlinkedInstances ? frameGroup.getUnlinkedInstances(cam) || [] : [];
    // per type, as the skeletons are coloured (`drawUnlinkedInstances`, the node tooltip)
    var dupUser = unlinkedDupIndices(unl, 'user'), dupPred = unlinkedDupIndices(unl, 'predicted');
    var userTracks = new Set();
    unl.forEach(function (u) { var t = u.instance && u.instance.type; if (t !== 'predicted' && Number.isInteger(u.instance.trackIdx)) userTracks.add(u.instance.trackIdx); });
    unl.forEach(function (u) {
        var inst = u.instance;
        if (!anyPoint(inst)) return;
        if (inst.type === 'predicted' && Number.isInteger(inst.trackIdx) && userTracks.has(inst.trackIdx)) return;
        if (inst.type === 'predicted' && placed.some(function (p) { return meanGap(p, inst) < 10; })) return;
        var a = animalFromInstance(inst, edges, chain);
        if (!a.body.length) return;
        placed.push(inst);
        var t = Number.isInteger(inst.trackIdx) && inst.trackIdx >= 0 ? inst.trackIdx : null;
        a.name = t != null ? ((session.tracks && session.tracks[t]) || ('Track ' + t)) : 'Unlinked ' + (out.length + 1);
        a.color = unlinkedBaseColor(inst, (inst.type === 'predicted' ? dupPred : dupUser).get(inst) || 0, session, cam, useId, frameIdx);
        a.identity = session.getIdentityIdForUnlinkedInstance ? (function () {
            var id = session.getIdentityIdForUnlinkedInstance(cam, inst, frameIdx);
            return Number.isInteger(id) && id >= 0 ? id : null;
        })() : null;
        a.track = t;
        a.source = '2d';
        a.ref = { kind: 'unlinked', id: u.id };
        out.push(a);
    });
    return out;
}

// A cheap signature of the poses an outline was made from.
function poseSignature(animals) {
    var h = 2166136261 >>> 0;
    function mix(v) {
        var q = Math.round(v * 4);
        h = Math.imul(h ^ (q & 0xffff), 16777619) >>> 0;
        h = Math.imul(h ^ (q >>> 16), 16777619) >>> 0;
    }
    animals.forEach(function (a) {
        mix(a.body.length); a.body.forEach(mix);
        mix(a.tail ? a.tail.length : 0); if (a.tail) a.tail.forEach(mix);
        mix(a.segments.length);
        mix(a.tubes ? a.tubes.length : 0); if (a.tubes) a.tubes.forEach(mix);
    });
    return animals.length + ':' + h.toString(36);
}

// ---------------------------------------------------------------------------
// Empty arenas
// ---------------------------------------------------------------------------

/**
 * Up to `n` frames spread over a `total`-frame video, each the keyframe
 * nearest its even spacing when `keyframes` (sorted) are known and there are
 * at least min(n, 15) of them, so each costs one decode; otherwise evenly
 * spaced frames (a short clip: a median of 3 keyframes would keep the animals).
 * Every frame when n >= total. Distinct, ascending.
 */
export function sampleFrames(total, keyframes, n) {
    if (!(total > 0) || !(n > 0)) return [];
    if (n >= total) return Array.from({ length: total }, function (_, i) { return i; });   // every frame
    var picks = [];
    var useKf = !!(keyframes && keyframes.length >= Math.min(n, 15));
    var pool = useKf ? keyframes : null;
    var count = Math.min(n, useKf ? pool.length : total);
    for (var i = 0; i < count; i++) {
        var target = Math.round(((i + 0.5) / count) * (total - 1));
        if (!useKf) { picks.push(target); continue; }
        // nearest keyframe (binary search)
        var lo = 0, hi = pool.length - 1;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (pool[mid] < target) lo = mid + 1; else hi = mid; }
        var best = pool[lo];
        if (lo > 0 && Math.abs(pool[lo - 1] - target) <= Math.abs(best - target)) best = pool[lo - 1];
        picks.push(best);
    }
    picks = Array.from(new Set(picks)).filter(function (f) { return f >= 0 && f < total; });
    picks.sort(function (a, b) { return a - b; });
    return picks;
}

function viewTotalFrames(view) {
    var d = view && view.decoder;
    if (d && d.samples && d.samples.length) return d.samples.length;
    return state.totalFrames || 0;
}

// The animals' poses in `cam` on a sampled frame (for leaving them out of the
// empty arena): what the frame holds, hydrated first on the active lazy project.
async function posesAt(session, frame, cam) {
    try {
        if (session.lazyLoader) {
            if (session !== state.session) return null;
            await ensureLazyFrameData(frame);
        }
        var groups = session.instanceGroups ? session.instanceGroups.get(frame) || [] : [];
        var fg = session.getFrameGroup ? session.getFrameGroup(frame) : null;
        return animalsInView(session, frame, cam, groups, fg).map(function (a) { return { body: a.body, tail: a.tail, segments: a.segments, tubes: a.tubes, tubeError: a.tubeError, mirrors: a.mirrors }; });
    } catch (e) {
        return null;
    }
}

/**
 * Build the empty arena and area model of `view`'s camera (unless it has one
 * from the same decoder). -> the camera state.
 */
export async function buildBackground(session, view, onFrame) {
    var st = sessionState(session);
    var cam = view.name;
    var cur = st.cams.get(cam);
    if (cur && cur.decoder === view.decoder && (cur.status === 'ready' || cur.status === 'building')) return cur.promise || cur;
    var entry = { status: 'building', decoder: view.decoder, w: view.videoWidth, h: view.videoHeight };
    st.cams.set(cam, entry);
    entry.promise = (async function () {
        try {
            var d = view.decoder;
            if (!d || typeof d.peekFrame !== 'function' || !(view.videoWidth > 0)) throw new Error('no video');
            var total = viewTotalFrames(view);
            var kf = null;
            try { kf = await keyframeIndices(d); } catch (e) { kf = null; }
            var frames = sampleFrames(total, kf ? Array.from(kf) : null, BACKGROUND_FRAMES);
            var bitmaps = [], used = [], poses = [];
            for (var i = 0; i < frames.length; i++) {
                var bm = null;
                try { bm = await d.peekFrame(frames[i], view.videoWidth); } catch (e) { bm = null; }
                if (bm) { bitmaps.push(bm); used.push(frames[i]); poses.push(await posesAt(session, frames[i], cam)); }
                if (onFrame) onFrame(cam, i + 1, frames.length);
            }
            if (!bitmaps.length) throw new Error('no frames decoded');
            var n = outlineAnimalCount(session, cam, state.currentFrame);
            var res = await call(camKey(st, cam), {
                type: 'background', cam: camKey(st, cam), frames: bitmaps, w: view.videoWidth, h: view.videoHeight,
                nAnimals: n, params: currentOutlineParams(), poses: poses,
            }, bitmaps);
            Object.assign(entry, { status: 'ready', bg: res.bg, model: res.model, areas: res.areas, singles: res.singles, counts: res.counts, frames: used, nAnimals: n });
        } catch (e) {
            Object.assign(entry, { status: 'failed', error: String(e && e.message || e) });
        }
        delete entry.promise;
        return entry;
    })();
    return entry.promise;
}

/**
 * Rebuild the area model of every ready camera against a number of animals
 * (the toolbar's Animals field changed). Cheap: the sampled blob areas are kept.
 */
export function refitAreaModels(session, nAnimals) {
    if (!session) return;
    sessionState(session).cams.forEach(function (c) {
        if (c.status !== 'ready' || !c.areas) return;
        c.nAnimals = nAnimals;
        // learnt from the blobs holding one pose when there were any: the count does not change it
        var old = c.model;
        c.model = poseAreaModel(c.singles, currentOutlineParams()) || areaModel(c.areas, nAnimals, currentOutlineParams());
        // the surfaces found to reflect stay (they come from the sampled frames, not the count)
        if (c.model && old && old.mirrors && c.model.reach3d === old.reach3d) { c.model.mirrors = old.mirrors; c.model.mirrorStats = old.mirrorStats; }
    });
    sessionState(session).cache.clear();
}

/**
 * Empty arenas for every camera of `views` that has none, with a progress card.
 * Concurrent calls share one run. -> Promise
 */
export function ensureBackgrounds(session, views) {
    if (!session) return Promise.resolve();
    var st = sessionState(session);
    var todo = (views || []).filter(function (v) {
        var c = st.cams.get(v.name);
        return v.decoder && !(c && c.decoder === v.decoder && (c.status === 'ready' || c.status === 'failed'));
    });
    if (!todo.length) return st.building || Promise.resolve();
    if (st.building) return st.building;
    var done = 0, total = todo.length * BACKGROUND_FRAMES;
    var progress = {};
    var paint = function () {
        var sum = 0;
        for (var k in progress) sum += progress[k];
        done = sum;
        showLoadingProgress('Empty-arena images', Math.min(done, total), total, { title: 'Animal outlines', detail: todo.length + ' camera' + (todo.length === 1 ? '' : 's') });
    };
    paint();
    var queue = todo.slice();
    var workers = Math.min(4, queue.length);
    var run = function () {
        var v = queue.shift();
        if (!v) return Promise.resolve();
        return buildBackground(session, v, function (cam, i) { progress[cam] = i; paint(); }).then(run);
    };
    var runs = [];
    for (var i = 0; i < workers; i++) runs.push(run());
    st.building = Promise.all(runs).then(function () {
        hideLoading();
        st.building = null;
        st.cache.clear();
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lucid:outlines-changed'));
        redrawSoon();
    }, function (e) {
        hideLoading();
        st.building = null;
        throw e;
    });
    return st.building;
}

// ---------------------------------------------------------------------------
// Outlines per camera frame
// ---------------------------------------------------------------------------

function cacheKey(cam, frameIdx, sig) { return cam + '\u0000' + frameIdx + '\u0000' + sig; }

function cachePut(st, key, val) {
    st.cache.delete(key);
    st.cache.set(key, val);
    while (st.cache.size > OUTLINE_CACHE_SIZE) st.cache.delete(st.cache.keys().next().value);
}

var _announce = 0;
// The Outlines panel lists the suspects on the frame shown: tell it when outlines land.
function announceSoon() {
    if (_announce || typeof window === 'undefined') return;
    _announce = setTimeout(function () {
        _announce = 0;
        window.dispatchEvent(new CustomEvent('lucid:outlines-landed'));
    }, 150);
}

var _redrawQueued = false;
function redrawSoon() {
    if (_redrawQueued || typeof requestAnimationFrame === 'undefined') return;
    _redrawQueued = true;
    requestAnimationFrame(function () {
        _redrawQueued = false;
        if (state.session && !state.isPlaying) drawAllOverlays(state.currentFrame);
    });
}

/**
 * The outlines of camera `view` at `frameIdx` for these `animals`, computed
 * now (no queue). -> {frame, cam, animals, result} or null (no empty arena or
 * no frame).
 */
export async function computeViewOutlines(session, view, frameIdx, animals) {
    var st = sessionState(session);
    var c = st.cams.get(view.name);
    if (!c || c.status !== 'ready') {
        c = await buildBackground(session, view);
        if (!c || c.status !== 'ready') return null;
    }
    var bm = await view.decoder.peekFrame(frameIdx, view.videoWidth);
    if (!bm) return null;
    var res = await call(camKey(st, view.name), {
        type: 'outline', cam: camKey(st, view.name), frame: bm, w: c.w, h: c.h,
        animals: animals.map(function (a) { return { body: a.body, segments: a.segments, tail: a.tail, tailPts: a.tailPts, tubes: a.tubes, tubeError: a.tubeError, mirrors: a.mirrors }; }),
        model: c.model || null, params: currentOutlineParams(),
    }, [bm]);
    var entry = { frame: frameIdx, cam: view.name, w: c.w, h: c.h, animals: animals, result: res, sig: poseSignature(animals) };
    // Do the poses agree with the outlines? Keypoints off their own outline, where the
    // image shows something, make it a suspect (checked in the worker, which has the frame).
    entry.check = res.check || keypointCheck(res.labels, c.w, c.h, animals, KEYPOINT_REACH);
    entry.suspects = outlineSuspects(entry.check, res.animals.map(function (a) { return a.area; }), animals.map(function (a) { return a.name; }));
    // Only a camera's newest outline keeps its label image whole (w x h bytes:
    // 1.3 MB at 1280x1024); older ones keep it run-length encoded (a few KB),
    // decoded again when needed (`entryLabels`).
    st.cache.forEach(function (e) {
        if (e.cam === view.name && e.result && e.result.labels && !e.edited) {
            e.result.labelsRle = rleEncode(e.result.labels);
            e.result.labels = null;
        }
    });
    cachePut(st, cacheKey(view.name, frameIdx, entry.sig), entry);
    return entry;
}

function pump(session, st, cam) {
    if (st.busy.has(cam)) return;
    var job = st.want.get(cam);
    if (!job) return;
    st.want.delete(cam);
    st.busy.add(cam);
    // A request that never settles (its decoder closed under it) must not hold
    // the camera's queue: give up on it after JOB_TIMEOUT_MS.
    var timer;
    var guard = new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('timed out')); }, JOB_TIMEOUT_MS); });
    Promise.race([computeViewOutlines(session, job.view, job.frame, job.animals), guard]).finally(function () { clearTimeout(timer); }).catch(function (e) {
        if (typeof console !== 'undefined') console.warn('[outlines] ' + cam + ' frame ' + job.frame + ': ' + (e && e.message || e));
    }).then(function (entry) {
        st.busy.delete(cam);
        if (entry && state.session === session && !state.isPlaying) { redrawSoon(); announceSoon(); }
        pump(session, st, cam);
    });
}

/** Outlines cached for camera `cam` at `frameIdx` with these poses, or null. */
export function cachedOutlines(session, cam, frameIdx, animals) {
    if (!session) return null;
    return sessionState(session).cache.get(cacheKey(cam, frameIdx, poseSignature(animals))) || null;
}

/** The outlines last drawn in camera `cam` (`{frame, animals, result}`), or null. */
export function drawnOutlines(session, cam) {
    if (!session) return null;
    return sessionState(session).lastDrawn.get(cam) || null;
}

/**
 * Draw a view's outlines on its overlay canvas, BEHIND what is already there
 * (`destination-over`): called by `drawAllOverlays` (ui/rendering.js) right
 * after the skeletons. Asks for missing outlines when paused.
 */
export function drawAnimalOutlines(view, frameIdx, frameGroup, groups, opts) {
    var session = state.session;
    if (!session || !outlinesEnabled() || !view || !view.overlayCtx) return;
    var st = sessionState(session);
    var paintOpts = {
        videoWidth: view.videoWidth, videoHeight: view.videoHeight,
        overlaySizeScale: opts && opts.overlaySizeScale != null ? opts.overlaySizeScale : 1,
        fillAlpha: fillAlpha(),
    };
    // An outline corrected by hand wins over the computed one.
    var edited = editedEntry(session, frameIdx, view.name);
    if (edited) {
        st.lastDrawn.set(view.name, edited);
        paintOutlines(view.overlayCtx, edited, paintOpts);
        if (_afterPaint) _afterPaint(view, frameIdx, edited, paintOpts);
        return;
    }
    var animals = animalsInView(session, frameIdx, view.name, groups, frameGroup);
    var entry = st.cache.get(cacheKey(view.name, frameIdx, poseSignature(animals)));
    if (!entry) {
        st.lastDrawn.delete(view.name);
        if (state.isPlaying || !view.decoder) return;
        var c = st.cams.get(view.name);
        if (!c || c.decoder !== view.decoder) {
            ensureBackgrounds(session, state.views.filter(isViewDocked).length ? state.views.filter(isViewDocked) : state.views).catch(function () {});
            return;
        }
        if (c.status !== 'ready') return;
        st.want.set(view.name, { view: view, frame: frameIdx, animals: animals });
        pump(session, st, view.name);
        return;
    }
    st.lastDrawn.set(view.name, entry);
    paintOutlines(view.overlayCtx, entry, paintOpts);
    paintSuspectKeypoints(view.overlayCtx, entry, paintOpts);
    if (_afterPaint) _afterPaint(view, frameIdx, entry, paintOpts);
}

/**
 * Red rings on the keypoints of each suspect animal (`entry.suspects`) that its
 * outline misses, over everything: where the pose says the outline is wrong.
 */
export function paintSuspectKeypoints(ctx, entry, opts) {
    if (!entry || !entry.suspects || !entry.suspects.length || !entry.check) return;
    var sx = ctx.canvas.width / (opts.videoWidth || entry.w), sy = ctx.canvas.height / (opts.videoHeight || entry.h);
    var s = opts.overlaySizeScale || 1;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 2.5 * s;
    entry.suspects.forEach(function (sus) {
        var c = entry.check[sus.animal];
        if (!c) return;
        for (var j = 0; j < c.out.length; j += 4) {
            if (sus.reason === 'tail' && c.out[j + 2] !== 1) continue;
            if (sus.reason !== 'tail' && sus.reason !== 'missed' && c.out[j + 2] === 1) continue;
            ctx.beginPath();
            ctx.arc(c.out[j] * sx, c.out[j + 1] * sy, 7 * s, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.lineWidth = 4.5 * s;
            ctx.stroke();
            ctx.strokeStyle = '#ff3b30';
            ctx.lineWidth = 2.5 * s;
            ctx.stroke();
        }
    });
    ctx.restore();
}

/**
 * Check the outlines of every camera in `views` on `frames` (ascending) for
 * keypoints off their outline, computing what is not cached; lazy frames are
 * hydrated first. `onProgress(done, total)`; `cancelled()` stops between
 * frames. -> [{frame, camera, animal, identity, track, source, reason, detail,
 * weight}] (also kept as the session's last scan, `outlineScan`).
 */
export async function scanOutlines(session, views, frames, onProgress, cancelled) {
    var st = sessionState(session);
    await ensureBackgrounds(session, views);
    var ready = views.filter(function (v) { var c = st.cams.get(v.name); return c && c.status === 'ready'; });
    var found = [];
    for (var i = 0; i < frames.length; i++) {
        if (cancelled && cancelled()) break;
        var f = frames[i];
        if (session.lazyLoader && session === state.session) await ensureLazyFrameData(f);
        var groups = session.instanceGroups ? session.instanceGroups.get(f) || [] : [];
        var fg = session.getFrameGroup ? session.getFrameGroup(f) : null;
        var entries = await Promise.all(ready.map(function (v) {
            var animals = animalsInView(session, f, v.name, groups, fg);
            var hit = st.cache.get(cacheKey(v.name, f, poseSignature(animals)));
            if (hit && hit.suspects) return hit;
            return computeViewOutlines(session, v, f, animals).catch(function () { return null; });
        }));
        entries.forEach(function (e, vi) {
            if (!e || !e.suspects) return;
            e.suspects.forEach(function (sus) {
                var a = e.animals[sus.animal] || {};
                found.push({ frame: f, camera: ready[vi].name, animal: a.name || null, identity: a.identity, track: a.track, source: a.source,
                    reason: sus.reason, detail: sus.detail, weight: sus.weight });
            });
        });
        if (onProgress) onProgress(i + 1, frames.length);
    }
    st.scan = { frames: frames.length, results: found, at: new Date().toISOString() };
    return found;
}

/** The session's last scan (`{frames, results, at}`), or null. */
export function outlineScan(session) {
    return session ? sessionState(session).scan || null : null;
}

// The brush (ui/outline-brush.js) draws its cursor after a view's outlines.
var _afterPaint = null;
/** Set the hook run after a view's outlines are painted (`fn(view, frame, entry, opts)`), or null. */
export function setOutlinePaintHook(fn) { _afterPaint = fn || null; }

/**
 * A corrected outline as a drawable entry (`{frame, cam, w, h, animals, result:
 * {labels, contours, unassigned: [], blobs: []}, edited: true}`), or null. Its
 * contours are re-traced only when the edit changed (`edit.version`).
 */
export function editedEntry(session, frameIdx, cam) {
    var e = outlineEditAt(session, frameIdx, cam);
    if (!e) return null;
    if (!e._entry || e._entry.version !== e.version) {
        e._entry = {
            frame: e.frame, cam: e.camera, w: e.w, h: e.h, animals: e.animals, edited: true, version: e.version,
            result: { labels: e.labels, contours: labelImageContours(e.labels, e.w, e.h, e.animals.length), unassigned: [], blobs: [] },
        };
    }
    return e._entry;
}

function polyPath(ctx, poly) {
    if (!poly || poly.length < 2) return;
    ctx.moveTo(poly[0], poly[1]);
    for (var i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
    ctx.closePath();
}

/**
 * Paint `entry`'s outlines on `ctx` (canvas px = video px x canvas/video size)
 * behind what is there: each animal's stroke in its colour over a fill at
 * `opts.fillAlpha`; animal-sized blobs nobody was given dashed grey.
 */
export function paintOutlines(ctx, entry, opts) {
    var r = entry && entry.result;
    if (!r) return;
    var cw = ctx.canvas.width, ch = ctx.canvas.height;
    var sx = cw / (opts.videoWidth || entry.w), sy = ch / (opts.videoHeight || entry.h);
    var lw = (2.5 * (opts.overlaySizeScale || 1)) / Math.max(sx, 1e-6);
    ctx.save();
    ctx.globalCompositeOperation = opts.over ? 'source-over' : 'destination-over';
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.lineJoin = 'round';
    // destination-over: what is drawn first ends up on top, so strokes before fills
    (r.unassigned || []).forEach(function (poly) {
        ctx.beginPath(); polyPath(ctx, poly);
        ctx.setLineDash([4 * lw, 3 * lw]);
        ctx.strokeStyle = 'rgba(200,200,200,0.9)';
        ctx.lineWidth = lw;
        ctx.stroke();
    });
    ctx.setLineDash([]);
    (r.contours || []).forEach(function (polys, k) {
        var a = entry.animals[k];
        if (!a || !polys.length) return;
        ctx.beginPath();
        polys.forEach(function (p) { polyPath(ctx, p); });
        ctx.strokeStyle = a.color;
        ctx.lineWidth = lw;
        ctx.globalAlpha = 1;
        ctx.stroke();
    });
    var alpha = opts.fillAlpha != null ? opts.fillAlpha : 0.25;
    if (alpha > 0) {
        (r.contours || []).forEach(function (polys, k) {
            var a = entry.animals[k];
            if (!a || !polys.length) return;
            ctx.beginPath();
            polys.forEach(function (p) { polyPath(ctx, p); });
            ctx.fillStyle = a.color;
            ctx.globalAlpha = alpha;
            ctx.fill();
        });
    }
    ctx.restore();
}

/** An outline entry's label image (decoding a compacted one). null when it has none. */
export function entryLabels(entry) {
    var r = entry && entry.result;
    if (!r) return null;
    if (!r.labels && r.labelsRle) r.labels = rleDecode(r.labelsRle, entry.w * entry.h);
    return r.labels || null;
}

/**
 * The animal whose drawn outline holds video point (x, y) in camera `cam`:
 * `{index, animal}` (its place in the outline's animal list), else null.
 */
export function outlineAnimalAt(session, cam, x, y) {
    var e = drawnOutlines(session, cam);
    if (!e || !e.result) return null;
    var labels = entryLabels(e);
    var xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
    if (labels && xi >= 0 && yi >= 0 && xi < e.w && yi < e.h) {
        var v = labels[yi * e.w + xi];
        if (v > 0 && e.animals[v - 1]) return { index: v - 1, animal: e.animals[v - 1] };
    }
    var polys = e.result.contours || [];
    for (var k = 0; k < polys.length; k++) {
        if (polys[k].some(function (p) { return pointInPolygon(p, x, y); })) return { index: k, animal: e.animals[k] };
    }
    return null;
}

/** For tests: the pool's mode and size, and (with a session) its queues. */
export function __outlinePoolInfo(session) {
    var P = pool();
    var st = session ? sessionState(session) : null;
    return { inline: P.inline, workers: P.workers.length, pending: P.pending.size,
        busy: st ? Array.from(st.busy) : null, want: st ? Array.from(st.want.keys()) : null, cached: st ? st.cache.size : null };
}
