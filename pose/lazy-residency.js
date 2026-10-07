/**
 * lazy-residency.js — keeping a lazy project's RESIDENT window bounded.
 *
 * A lazy project (`session.lazyLoader`) materializes 2D frame by frame into
 * `session.frameGroups` as the playhead reaches it. Nothing used to give a frame
 * back: playback hydrated ~6,300 frames per 20 s run (its 5,000-frame lookahead
 * plus what it played), each drawn frame also left its re-derived reprojections
 * on the groups and in `state.triangulationResults`, and all of it lived for the
 * rest of the session. Measured on an 8-camera, 108,000-frame project after
 * Track All + Triangulate All (tests/e2e/_bench-playback.mjs): app draws went
 * 58 -> 59 -> 15 -> 19 per second over four 20 s runs, and a Chrome trace of the
 * degraded state put 71% of the main thread in the garbage collector — 20 major
 * GCs in 12 s, ~250 ms each, every one a FULL mark of the object graph plus a
 * sweep of every ArrayBuffer. Their recorded reason is external-memory
 * pressure — set by what playback allocates, not by heap size (the V8 heap was
 * ~1.33 GB at every one; most of `usedJSHeapSize` is ArrayBuffer backing
 * stores). What grew run by run was the COST of each GC, with the live graph.
 * The JS heap barely moved (+100 MB), so the growth looked harmless while it
 * pushed V8 past the point where concurrent marking keeps up.
 *
 * So the playback loop now trims the window as it goes
 * (`trimLazyResidency`, called from `ui/ui-wiring.js`'s lazy playback loader),
 * and a sync loader's lookahead is 600 frames instead of 5,000
 * (`lazyPlaybackLookahead`). Paused navigation — stepping, scrubbing, seeking —
 * is bounded the same way, by `ensureLazyFrameData` (pose/triangulation.js),
 * the one place a frame enters while paused: it trims `LAZY_NAV_WINDOW` frames
 * either side of the frame it just hydrated, except while playing. Same project, back to back: 59.5 / 59.7 / 10.7 /
 * 16.9 draws/s before, 59.4 / 59.4 / 58.5 / 58.0 after, with ~900 resident
 * frames instead of 19k and GC at 17% of the main thread instead of 77%.
 *
 * ## What may be evicted: only a frame a rebuild reproduces EXACTLY
 *
 * An evicted frame comes back through the normal hydration path
 * (`ensureLazyFrameData` -> `finalizeLazyFrameGroup`, pose/triangulation.js):
 * one `Instance` per store row, linked to the group member that claims its
 * (camera, `_rawInstIndex`), the rest unlinked. Anything that is not a function
 * of (store, `instanceGroups`) would be lost or resurrected — a deleted
 * prediction coming back, a reassigned track reverting. There is no edit flag
 * that every edit path sets (`onInstanceDeleted` and `onNodeSetNull` never call
 * `markDirty`), so `lazyFrameIsRebuildable` checks the frame itself against the
 * store instead: every store row present exactly once, each linked instance the
 * member that claims that row, each unlinked one still the predicted, unedited,
 * identity-free row with the store's track. Anything else stays resident.
 * The store side costs one `instanceRowSpan` per camera — no materialization.
 *
 * Only `SioLazyLoader` (the large-`.slp` loader, `isSync`) offers that. A
 * worker-backed `LazyFrameLoader` cannot answer synchronously, so its frames
 * are never evicted here and its playback keeps the old lookahead.
 *
 * ## Derived caches go with the frame
 *
 * Evicting a frame also drops what `fillLazyReprojections` (ui/rendering.js)
 * derived for it — `group.reprojections`, `group.reprojectedInstances` and the
 * frame's `state.triangulationResults` entry — for CLEAN groups only. That fill
 * recomputes them on the next draw of the frame, exactly as it does for a frame
 * never visited (the Triangulate All sweep drops them project-wide for the same
 * reason). A DIRTY group's caches are left: they describe the 3D as it was
 * before an edit, and re-deriving them would silently change what is shown.
 *
 * ## Never during a bulk operation
 *
 * `sweepLazyFrameWindows` and `loadAllLazyFrames` hydrate a window, `await`,
 * and then read `session.frameGroups`. Evicting in between would make them skip
 * frames — the #194/#195 resident-only bug class, silently. They hold
 * `holdLazyResidency()` for their whole run and eviction is a no-op meanwhile.
 * A new operation of that shape must do the same.
 *
 * DOM-free, and imports only `pose/pose-data.js`, so `tests/test-lazy-residency.mjs`
 * runs it against the real hydration path in Node, and `ui/image-embedder.js`
 * (loaded by Node tests too) can take `hydrateGroupMembers2D` from here.
 */

import { Instance } from './pose-data.js';

/** Frames kept behind the playhead while playing (5 s at 60 fps). */
export var LAZY_PLAYBACK_BEHIND = 300;
/**
 * Frames kept on EACH side of the frame being viewed while paused
 * (`ensureLazyFrameData`'s trim, pose/triangulation.js) — covers its 30-frame
 * prefetch in either direction with room to step back and forth.
 */
export var LAZY_NAV_WINDOW = 300;
/** Lookahead while playing, for a loader that materializes synchronously. */
export var LAZY_PLAYBACK_AHEAD_SYNC = 600;
/** Lookahead for a worker-backed loader — unchanged, it is not trimmed. */
export var LAZY_PLAYBACK_AHEAD_ASYNC = 5000;
/**
 * Frames past the window `trimLazyResidency` lets accumulate before it scans,
 * so a playback tick costs nothing in the steady state.
 */
export var LAZY_TRIM_SLACK = 120;

var _holds = 0;

/**
 * Suspend eviction until the returned function is called (idempotent). Taken
 * by every operation that hydrates frames and reads them back across an
 * `await`.
 * @returns {function(): void} release
 */
export function holdLazyResidency() {
    _holds++;
    var released = false;
    return function releaseLazyResidency() {
        if (released) return;
        released = true;
        _holds--;
    };
}

/** @returns {boolean} whether some operation currently holds residency. */
export function lazyResidencyHeld() {
    return _holds > 0;
}

/**
 * The trackIdx an `Instance` hydrated from a lazy loader carries: the loader's
 * own index, or `null` for no track. Both lazy loaders hand over the COLUMNAR
 * store's trackless value, `-1` (`SioLazyLoader`'s `adaptTypedInstance`; a
 * `LazyFrameLoader` frame re-indexed out of range), and the four hydration
 * paths in pose/triangulation.js — `ensureLazyFrameData`, `hydrateLazyCameras`,
 * `buildLazyFrameGroupSync`, `batchLoadLazyFrames` — used to pass it straight
 * into `new Instance`. The in-memory sentinel is `null`
 * (`resolveImportTrackIdx`, which every eager path applies), and the code that
 * reads it tests `trackIdx == null`: with `-1`, `getInstanceColor` drew a
 * trackless instance in the palette's last track colour instead of the
 * ungrouped one, `getInstanceLabelName` gave it a "Track -1" pill, and both
 * ignored the identity an ungrouped trackless instance retains (luc3d #201).
 * The store itself keeps `-1` — `appendStore`, `forEachInstanceRow` and
 * `remapTracksFromIdentity` all speak it — so this is applied where a store row
 * becomes an `Instance`, and nowhere earlier. `frameIdentityMap` keys both the
 * same (`Session._fimKey`), so no saved identity moves.
 *
 * Lives here (re-imported by pose/triangulation.js) because the eviction check
 * below has to apply the same mapping to the store's track column.
 */
export function lazyInstanceTrackIdx(trackIdx) {
    return (typeof trackIdx === 'number' && trackIdx >= 0) ? trackIdx : null;
}

var _span = [0, 0];
// Rows of the current (camera, frame) already accounted for — reused scratch.
var _seen = new Uint8Array(64);

/** Mark store-row offset `r` (of `n`) as present; false if invalid or seen twice. */
function claimRow(r, n) {
    if (typeof r !== 'number' || !(r >= 0 && r < n) || r !== Math.floor(r) || _seen[r]) return false;
    _seen[r] = 1;
    return true;
}

/** The member of `groups` at (`cam`, `rawIdx`), or null. */
function memberAt(groups, cam, rawIdx) {
    if (!groups) return null;
    for (var gi = 0; gi < groups.length; gi++) {
        var m = groups[gi].instances.get(cam);
        if (m && m._rawInstIndex === rawIdx) return m;
    }
    return null;
}

function nonEmpty(list) { return !!(list && list.length > 0); }

/**
 * Would dropping `fg` and hydrating `frameIdx` again produce the same frame?
 * True only when every instance in it is exactly what hydration builds from the
 * store and `session.instanceGroups` — see the module header for why that is
 * checked rather than tracked. Conservative: anything it cannot vouch for
 * (a loader without `instanceRowSpan`, a camera the loader does not back, an
 * instance with no store row) answers false.
 *
 * @param {Object} session - LUCID Session with a `lazyLoader`
 * @param {number} frameIdx
 * @param {FrameGroup} fg - the resident group for `frameIdx`
 * @returns {boolean}
 */
export function lazyFrameIsRebuildable(session, frameIdx, fg) {
    var loader = session && session.lazyLoader;
    if (!fg || !loader || typeof loader.instanceRowSpan !== 'function' ||
        typeof loader.storeTrackAt !== 'function' || !loader.labelsByCam) return false;
    var cams = loader.labelsByCam;

    // Data under a camera the loader does not back came from somewhere else
    // (an eager parse) and would not come back.
    for (var [lcn, linkedAll] of fg.instances) if (!cams.has(lcn) && nonEmpty(linkedAll)) return false;
    for (var [ucn, unlinkedAll] of fg.unlinkedInstances) if (!cams.has(ucn) && nonEmpty(unlinkedAll)) return false;

    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    if (groups) {
        for (var gi = 0; gi < groups.length; gi++) {
            for (var [, m] of groups[gi].instances) {
                if (m && (m.type === 'user' || m.modified)) return false;
            }
        }
    }

    for (var cam of cams.keys()) {
        var span = loader.instanceRowSpan(cam, frameIdx, _span);
        var start = span ? span[0] : 0;
        var n = span ? Math.max(0, span[1] - span[0]) : 0;
        var linked = fg.instances.get(cam) || [];
        var unlinked = fg.unlinkedInstances.get(cam) || [];
        // Every store row exactly once (hydration puts each row in one of the two).
        if (linked.length + unlinked.length !== n) return false;
        if (n === 0) continue;
        if (_seen.length < n) _seen = new Uint8Array(n); else _seen.fill(0, 0, n);
        for (var li = 0; li < linked.length; li++) {
            var inst = linked[li];
            if (!inst || !claimRow(inst._rawInstIndex, n)) return false;
            if (inst.type === 'user' || inst.modified) return false;
            // Hydration links a row to the member claiming it — so this must BE that member.
            if (memberAt(groups, cam, inst._rawInstIndex) !== inst) return false;
        }
        for (var ui = 0; ui < unlinked.length; ui++) {
            var ul = unlinked[ui];
            var u = ul && ul.instance;
            if (!u || !claimRow(u._rawInstIndex, n)) return false;
            if (u.type !== 'predicted' || u.modified) return false;
            if (u.identityId != null) return false;                       // luc3d #201: lives only here
            if (u.nulledNodes && u.nulledNodes.size > 0) return false;
            // ...and a row some member claims would come back linked, not unlinked.
            if (memberAt(groups, cam, u._rawInstIndex)) return false;
            // A track reassigned in memory is not in the store; hydration would revert it.
            if (u.trackIdx !== lazyInstanceTrackIdx(loader.storeTrackAt(cam, start + u._rawInstIndex))) return false;
        }
    }
    return true;
}

/**
 * Drop what `fillLazyReprojections` derived for `frameIdx`'s CLEAN groups, and
 * those groups' entries in `triangulationResults` (entries for groups no longer
 * on the frame go too — the info panel already ignores them). A dirty group's
 * caches, and entries with no group, are kept.
 */
function dropDerivedFrameCaches(session, frameIdx, triangulationResults) {
    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    var keepGroups = null;
    if (groups) {
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (g.dirty) { (keepGroups || (keepGroups = new Set())).add(g); continue; }
            if (g.reprojections) g.reprojections = null;
            if (g.reprojectedInstances && g.reprojectedInstances.size) g.reprojectedInstances.clear();
        }
    }
    if (!triangulationResults || !triangulationResults.has(frameIdx)) return;
    var list = triangulationResults.get(frameIdx) || [];
    var rest = list.filter(function (r) { return !r || !r.group || (keepGroups && keepGroups.has(r.group)); });
    if (rest.length === 0) triangulationResults.delete(frameIdx);
    else if (rest.length !== list.length) triangulationResults.set(frameIdx, rest);
}

/**
 * Evict every resident frame outside `[lo, hi]` that `lazyFrameIsRebuildable`
 * vouches for, with its derived caches. A no-op while residency is held.
 *
 * @param {Object} session
 * @param {number} lo - first frame of the window to keep (inclusive)
 * @param {number} hi - last frame of the window to keep (inclusive)
 * @param {{keep?: number, triangulationResults?: Map}} [opts] - `keep`: a frame
 *   never to evict (the one on screen); `triangulationResults`: the map to prune
 *   (`state.triangulationResults`).
 * @returns {{evicted: number, keptOutside: number, held: boolean}}
 */
export function evictLazyFramesOutside(session, lo, hi, opts) {
    var res = { evicted: 0, keptOutside: 0, held: _holds > 0 };
    if (res.held || !session || !session.lazyLoader || !session.frameGroups) return res;
    var keep = opts && opts.keep != null ? opts.keep : null;
    var victims = [];
    for (var [f, fg] of session.frameGroups) {
        if ((f >= lo && f <= hi) || f === keep) continue;
        if (lazyFrameIsRebuildable(session, f, fg)) victims.push(f);
        else res.keptOutside++;
    }
    var tri = opts && opts.triangulationResults;
    for (var i = 0; i < victims.length; i++) {
        session.frameGroups.delete(victims[i]);
        dropDerivedFrameCaches(session, victims[i], tri);
        releaseFrameMembers2D(session, victims[i]);
    }
    res.evicted = victims.length;
    return res;
}

/**
 * May group member `m` (camera `cam`, frame `frameIdx`) give its 2D back to the
 * store? Only when that 2D IS the store row's: a predicted, unedited member
 * (no `modified`, no backup, no nulled nodes) of a camera the loader backs,
 * whose `_rawInstIndex` names a row the frame still has — the row hydration
 * (`finalizeLazyFrameGroup`) will adopt again.
 */
function memberIsStoreRow(loader, cam, frameIdx, m) {
    if (!m || m._lazy2d || typeof m.releaseLazy2d !== 'function') return false;
    if (m.type !== 'predicted' || m.modified || m._originalXY) return false;
    if (m.nulledNodes && m.nulledNodes.size > 0) return false;
    if (!loader.labelsByCam.has(cam)) return false;
    var r = m._rawInstIndex;
    if (typeof r !== 'number' || !(r >= 0) || r !== Math.floor(r)) return false;
    var span = loader.instanceRowSpan(cam, frameIdx, _span);
    return !!span && r < span[1] - span[0];
}

/**
 * Give the 2D of a NON-resident frame's group members back to the store
 * (`Instance.releaseLazy2d`): each eligible member becomes a `_lazy2d`
 * placeholder on the shared all-NaN buffer — exactly the state a lazily
 * reopened project's members are in — and is re-hydrated from its store row
 * the next time the frame is materialized. A resident frame is left alone: its
 * FrameGroup is showing those members.
 *
 * WHY: after Track All every member keeps the 2D its window was hydrated with
 * — 4,152,565 `Float64Array`s, each with its own ArrayBuffer, on the 8-camera,
 * 108,000-frame project. Every full GC marks and sweeps all of them: ~188 ms of
 * a ~373 ms full GC (`_bench-playback.mjs HEAPPROBE=1 STRIP=1`).
 *
 * @returns {number} members released
 */
export function releaseFrameMembers2D(session, frameIdx) {
    var loader = session && session.lazyLoader;
    if (!loader || !loader.labelsByCam || typeof loader.instanceRowSpan !== 'function') return 0;
    if (session.frameGroups && session.frameGroups.has(frameIdx)) return 0;
    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    if (!groups) return 0;
    var n = 0;
    for (var gi = 0; gi < groups.length; gi++) {
        for (var [cam, m] of groups[gi].instances) {
            if (memberIsStoreRow(loader, cam, frameIdx, m)) { m.releaseLazy2d(); n++; }
        }
    }
    return n;
}

/**
 * `releaseFrameMembers2D` for every non-resident frame — what a bulk operation
 * that hydrated the whole project (Track All, Triangulate All) leaves behind.
 * A no-op while residency is held. Synchronous: ~4M members in well under a
 * second, and nothing can observe a half-released project.
 * @returns {{frames: number, members: number, held: boolean}}
 */
export function releaseNonResidentMembers2D(session) {
    var res = { frames: 0, members: 0, held: _holds > 0 };
    if (res.held || !session || !session.lazyLoader || !session.instanceGroups) return res;
    for (var f of session.instanceGroups.keys()) {
        var k = releaseFrameMembers2D(session, f);
        if (k) { res.frames++; res.members += k; }
    }
    return res;
}

/**
 * Give `frameIdx`'s `_lazy2d` group members their 2D from the store WITHOUT
 * making the frame resident — for code that reads members' keypoints at frames
 * it never shows (the image ID-switch check's crop geometry). A lazily reopened
 * project's members, and after Track All / Triangulate All every unedited
 * member of a non-resident frame (`releaseFrameMembers2D`, above), are placeholders whose 2D is all-NaN until a frame
 * is hydrated; reading them directly sees no points at all.
 *
 * Builds each row exactly as the hydration paths do and adopts it
 * (`adoptPointsFrom`), so the member is indistinguishable from one hydrated by
 * `finalizeLazyFrameGroup`. Needs a synchronous loader (`getFrameSync`); a no-op
 * for a resident frame (already hydrated) or when no member is a placeholder.
 * @param {Object} session
 * @param {number} frameIdx
 * @returns {number} members hydrated
 */
export function hydrateGroupMembers2D(session, frameIdx) {
    var loader = session && session.lazyLoader;
    if (!loader || typeof loader.getFrameSync !== 'function' || !loader.isSync) return 0;
    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    if (!groups) return 0;
    var any = false;
    for (var gi = 0; gi < groups.length && !any; gi++) {
        for (var [, m0] of groups[gi].instances) { if (m0 && m0._lazy2d) { any = true; break; } }
    }
    if (!any) return 0;
    var data = loader.getFrameSync(frameIdx);
    if (!data) return 0;
    var n = 0;
    for (var gj = 0; gj < groups.length; gj++) {
        for (var [cam, m] of groups[gj].instances) {
            if (!m || !m._lazy2d || m._rawInstIndex == null) continue;
            var rows = data.get(cam);
            var d = rows ? rows[m._rawInstIndex] : null;
            if (!d) continue;
            m.adoptPointsFrom(new Instance(d.points || [], lazyInstanceTrackIdx(d.trackIdx), d.type || 'predicted', d.score || 0));
            m._lazy2d = false;
            n++;
        }
    }
    return n;
}

// session -> frames the last scan had to keep outside its window (edited ones).
var _keptOutside = new WeakMap();

/**
 * The playback trim: keep `[center - behind, center + ahead]` resident and evict
 * what is rebuildable outside it — but only scan once the resident count has
 * outgrown that window (plus the frames the last scan had to keep, plus
 * `LAZY_TRIM_SLACK`), so the steady state costs one comparison per call.
 *
 * @param {Object} session
 * @param {number} center - the frame being played
 * @param {{ahead: number, behind: number, keep?: number, slack?: number,
 *          triangulationResults?: Map}} opts - `slack` defaults to
 *   `LAZY_TRIM_SLACK`.
 * @returns {{evicted: number, keptOutside: number, held: boolean}|null} null when
 *   no scan was needed.
 */
export function trimLazyResidency(session, center, opts) {
    if (!session || !session.lazyLoader || !session.frameGroups) return null;
    // A loader that cannot answer `instanceRowSpan` (worker-backed) has nothing
    // evictable; skip the periodic rescan that would rediscover that.
    if (typeof session.lazyLoader.instanceRowSpan !== 'function') return null;
    var slack = opts.slack != null ? opts.slack : LAZY_TRIM_SLACK;
    var budget = opts.ahead + opts.behind + 1 + (_keptOutside.get(session) || 0) + slack;
    if (session.frameGroups.size <= budget) return null;
    var r = evictLazyFramesOutside(session, center - opts.behind, center + opts.ahead, opts);
    if (!r.held) _keptOutside.set(session, r.keptOutside);
    return r;
}

/**
 * How far ahead of the playhead playback keeps frames hydrated. A sync loader
 * (`SioLazyLoader`) builds a frame on demand in about a millisecond and is
 * trimmed behind the playhead, so 10 s at 60 fps is plenty — the old 5,000
 * also meant a 5,000-frame synchronous build when playback started. A
 * worker-backed loader keeps 5,000: it answers asynchronously, in batches.
 * @param {Object} loader - `session.lazyLoader`
 * @returns {number}
 */
export function lazyPlaybackLookahead(loader) {
    return loader && loader.isSync ? LAZY_PLAYBACK_AHEAD_SYNC : LAZY_PLAYBACK_AHEAD_ASYNC;
}
