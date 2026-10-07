/**
 * lazy-residency.js — keeps a LAZY project's resident frames bounded.
 *
 * On a lazy project `session.frameGroups` is meant to be a window: frames are
 * hydrated from the columnar store as they are shown (`ensureLazyFrameData`,
 * the playback loader's `batchLoadLazyFrames`) and are supposed to go again.
 * Nothing ever dropped them during playback, so every played frame stayed —
 * 373 -> 19,393 resident frame groups over four 20 s runs on a real 8-camera
 * project, and the JS heap with it. Two more per-frame caches grew alongside:
 * the reprojections `ui/rendering.js` `fillLazyReprojections` re-derives for
 * every drawn frame after a Triangulate All (`group.reprojections`,
 * `group.reprojectedInstances`, `state.triangulationResults`).
 *
 * `evictLazyFrameGroups` drops a frame only when doing so cannot lose anything:
 *
 *  1. **It is outside every protected window** — `[anchor - behind,
 *     anchor + ahead]` around the on-screen frame and the frame being
 *     hydrated. `ahead` covers the playback loader's lookahead, so playback
 *     never re-hydrates what it just loaded; `behind` covers the longest node
 *     trail (trails draw RESIDENT past frames only).
 *  2. **Re-hydrating it would rebuild exactly what is resident**
 *     (`frameEvictionBlocker`). Re-hydration is `getFrameSync` → one Instance
 *     per store row, tagged `_rawInstIndex` → `finalizeLazyFrameGroup`, which
 *     re-seats this frame's `instanceGroups` members by `_rawInstIndex` and
 *     sends every other row to the unlinked pool. Group members are never
 *     lost: they live in `session.instanceGroups`, which is never evicted, and
 *     come back as the SAME objects. Unlinked instances are rebuilt from the
 *     store, so each must still equal its row. Anything else — a user instance
 *     (the streaming save reads its edit overlay from resident frames, see
 *     `buildSessionRefGraph`), an edited/backed-up/nulled instance, a deleted or
 *     added row, a track changed only in memory, a trackless instance carrying
 *     an identity (#201, not persisted), a skeleton-node change, a camera the
 *     loader does not back, or an object the UI is holding — keeps the frame.
 *  3. **No sweep is running** (`holdLazyResidency`). Track All / Triangulate All
 *     hydrate a window and read it back after awaits; they release windows
 *     themselves.
 *
 * Dropping a frame also drops its DERIVED reprojection caches — the exact state
 * Triangulate All leaves every frame in (`sweepTriangulateAllFrames`), from
 * which the draw path re-derives them on the next visit.
 *
 * DOM-free and import-free so `tests/test-lazy-residency.mjs` can drive it
 * directly; `pose/triangulation.js` `evictLazyFrames` supplies the app state.
 */

/** Frames the playback loader keeps hydrated ahead of the playhead. */
export const LAZY_PLAYBACK_AHEAD = 600;
/**
 * Frames kept behind every anchor. Node trails go up to 500 frames (the
 * overlay export's maximum) and draw only resident frames.
 */
export const LAZY_KEEP_BEHIND = 512;
/** Resident frame groups above which an eviction pass runs. */
export const LAZY_RESIDENT_CAP = 1536;
/**
 * `ensureLazyFrameData` also builds the next 30 frames in the scrub direction;
 * the protected window reaches past that so a pass never drops its own prefetch.
 */
export const LAZY_PREFETCH_MARGIN = 32;

var _holds = 0;
var _lastPass = null;

/**
 * Suspend eviction while a caller relies on hydrated frames STAYING resident
 * across awaits (the windowed sweeps). Nestable; pair every call with
 * `releaseLazyResidency` in a `finally`.
 */
export function holdLazyResidency() { _holds++; }
export function releaseLazyResidency() { if (_holds > 0) _holds--; }
export function isLazyResidencyHeld() { return _holds > 0; }

/** The most recent pass's report (see `evictLazyFrameGroups`), for diagnostics. */
export function lastLazyEvictionPass() { return _lastPass; }

var EMPTY = [];

function instanceBlocker(inst, desc, seen, numNodes, refs) {
    if (!inst) return 'instance';
    if (refs && refs.has(inst)) return 'ui';
    if (inst.type === 'user') return 'user';
    if (inst.modified) return 'modified';
    if (typeof inst.hasBackup === 'function' && inst.hasBackup()) return 'modified';
    if (inst.nulledNodes && inst.nulledNodes.size > 0) return 'modified';
    var k = inst._rawInstIndex;
    if (typeof k !== 'number' || !(k >= 0 && k < desc.count) || k !== Math.floor(k)) return 'row';
    if (seen[k]) return 'row';
    seen[k] = 1;
    if (numNodes > 0 && inst.numNodes !== numNodes) return 'skeleton';
    return null;
}

/**
 * Why `fg` (resident at `frameIdx`) cannot be dropped and rebuilt from the
 * store — or `null` when it can. See the file header, point 2.
 *
 * @param {Object} session - needs `lazyLoader` with `describeStoreFrame`
 *   (`SioLazyLoader`), `labelsByCam`, `numNodesByCam`; and `instanceGroups`
 * @param {number} frameIdx
 * @param {Object} fg - the resident FrameGroup
 * @param {Set<Object>} [refs] - objects the UI holds (InstanceGroups,
 *   Instances, UnlinkedInstances); a frame containing one is kept
 * @returns {string|null} a short reason: 'loader', 'camera', 'ui', 'user',
 *   'modified', 'row', 'count', 'skeleton', 'grouping', 'identity', 'track',
 *   'type', 'instance'
 */
export function frameEvictionBlocker(session, frameIdx, fg, refs) {
    var loader = session && session.lazyLoader;
    if (!loader || typeof loader.describeStoreFrame !== 'function' || !loader.labelsByCam) return 'loader';
    var camMap = loader.labelsByCam;

    // Data for a camera the loader does not back exists nowhere else.
    for (var [lcn, lList] of fg.instances) if (lList.length > 0 && !camMap.has(lcn)) return 'camera';
    for (var [ucn, uList] of fg.unlinkedInstances) if (uList.length > 0 && !camMap.has(ucn)) return 'camera';

    // camName -> Map(_rawInstIndex -> member), as `finalizeLazyFrameGroup` builds it.
    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    var memberAt = null;
    if (groups) {
        for (var gi = 0; gi < groups.length; gi++) {
            if (refs && refs.has(groups[gi])) return 'ui';
            for (var [mcn, m] of groups[gi].instances) {
                if (!m || m._rawInstIndex == null) continue;
                if (!memberAt) memberAt = new Map();
                var mm = memberAt.get(mcn);
                if (!mm) { mm = new Map(); memberAt.set(mcn, mm); }
                mm.set(m._rawInstIndex, m);
            }
        }
    }

    for (var cam of camMap.keys()) {
        var linked = fg.instances.get(cam) || EMPTY;
        var unlinked = fg.unlinkedInstances.get(cam) || EMPTY;
        var desc = loader.describeStoreFrame(cam, frameIdx);
        if (!desc) return 'camera';
        // With the per-row uniqueness below, equal counts make resident
        // instances and store rows a bijection: no row deleted, none added.
        if (linked.length + unlinked.length !== desc.count) return 'count';
        if (desc.count === 0) continue;
        var seen = new Uint8Array(desc.count);
        var numNodes = (loader.numNodesByCam && loader.numNodesByCam.get(cam)) || 0;
        var members = memberAt ? memberAt.get(cam) : null;

        // Linked: must be exactly the member re-hydration re-seats at this row.
        // The member object itself survives in `instanceGroups`.
        for (var li = 0; li < linked.length; li++) {
            var why = instanceBlocker(linked[li], desc, seen, numNodes, refs);
            if (why) return why;
            if (!members || members.get(linked[li]._rawInstIndex) !== linked[li]) return 'grouping';
        }
        // Unlinked: rebuilt from the store, so it must still match its row.
        for (var ui = 0; ui < unlinked.length; ui++) {
            var ul = unlinked[ui];
            if (!ul) return 'instance';
            if (refs && refs.has(ul)) return 'ui';
            var inst = ul.instance;
            var whyU = instanceBlocker(inst, desc, seen, numNodes, refs);
            if (whyU) return whyU;
            var k = inst._rawInstIndex;
            if (members && members.has(k)) return 'grouping';
            if (inst.identityId != null) return 'identity';
            var storeTrack = desc.trackIdx[k];
            if (inst.trackIdx !== (storeTrack >= 0 ? storeTrack : null)) return 'track';
            if ((inst.type === 'predicted') !== (desc.predicted[k] === 1)) return 'type';
        }
    }
    return null;
}

/**
 * Drop the derived reprojection caches of `frameIdx` — what
 * `sweepTriangulateAllFrames` drops project-wide before it starts. The draw
 * path (`fillLazyReprojections`) re-derives them when the frame is shown.
 */
function dropDerivedReprojections(session, frameIdx, triangulationResults) {
    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    if (groups) {
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (g.reprojections) g.reprojections = null;
            if (g.reprojectedInstances && g.reprojectedInstances.size) g.reprojectedInstances.clear();
        }
    }
    if (triangulationResults) triangulationResults.delete(frameIdx);
}

/**
 * Evict every resident frame of a lazy session that is outside the protected
 * windows and provably rebuildable (`frameEvictionBlocker`).
 *
 * @param {Object} session
 * @param {Object} opts
 * @param {number[]} opts.anchors - frames to protect a window around
 * @param {number} [opts.ahead=LAZY_PLAYBACK_AHEAD + LAZY_PREFETCH_MARGIN]
 * @param {number} [opts.behind=LAZY_KEEP_BEHIND]
 * @param {number} [opts.cap] - do nothing while `frameGroups.size <= cap`
 * @param {Set<Object>} [opts.refs] - see `frameEvictionBlocker`
 * @param {Map<number, Array>} [opts.triangulationResults] - entries of
 *   evicted frames are deleted
 * @returns {{resident: number, evicted: number, protected: number,
 *   blocked: Object<string, number>}|null} null when nothing ran (no lazy
 *   loader, under the cap, or held)
 */
export function evictLazyFrameGroups(session, opts) {
    opts = opts || {};
    if (!session || !session.lazyLoader || !session.frameGroups) return null;
    if (_holds > 0) return null;
    if (opts.cap != null && session.frameGroups.size <= opts.cap) return null;

    var ahead = opts.ahead != null ? opts.ahead : LAZY_PLAYBACK_AHEAD + LAZY_PREFETCH_MARGIN;
    var behind = opts.behind != null ? opts.behind : LAZY_KEEP_BEHIND;
    var anchors = [];
    for (var ai = 0; ai < (opts.anchors || EMPTY).length; ai++) {
        var a = opts.anchors[ai];
        if (typeof a === 'number' && isFinite(a)) anchors.push(a);
    }
    function isProtected(f) {
        for (var i = 0; i < anchors.length; i++) {
            if (f >= anchors[i] - behind && f <= anchors[i] + ahead) return true;
        }
        return false;
    }

    var doomed = [];
    var blocked = {};
    var protectedCount = 0;
    for (var [f, fg] of session.frameGroups) {
        if (isProtected(f)) { protectedCount++; continue; }
        var why = frameEvictionBlocker(session, f, fg, opts.refs);
        if (why) { blocked[why] = (blocked[why] || 0) + 1; continue; }
        doomed.push(f);
    }
    for (var d = 0; d < doomed.length; d++) {
        session.frameGroups.delete(doomed[d]);
        dropDerivedReprojections(session, doomed[d], opts.triangulationResults);
    }
    _lastPass = {
        resident: session.frameGroups.size,
        evicted: doomed.length,
        protected: protectedCount,
        blocked: blocked,
    };
    return _lastPass;
}
