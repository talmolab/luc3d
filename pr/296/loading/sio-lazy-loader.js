/**
 * sio-lazy-loader.js — main-thread lazy frame loader for large `.slp` files,
 * backed by sleap-io.js's streaming lazy reader (`readSlpStreaming({ lazy })`).
 *
 * Presents the SAME interface the app expects from `LazyFrameLoader`
 * (pose/triangulation.js) so it plugs into the existing `state.session.lazyLoader`
 * seam unchanged: `open(camName, file)`, `getFrame(frameIdx)`,
 * `getFrameSync(frameIdx)`, `prefetch(frameIdx, dir)`, `close()`, and the
 * `nFrames` / `skeleton` / `trackNames` / `videos` / `trackOccupancy` fields.
 *
 * Unlike `LazyFrameLoader` (which spins one Web Worker per camera to read a
 * SLEAP *analysis* `.h5`), this holds one lazy sleap-io.js `Labels` per camera on
 * the MAIN thread. `readSlpStreaming` already runs the heavy HDF5 I/O off-thread
 * in its own internal worker and hands back compact columnar arrays; frames are
 * then materialized on demand (`labels.frameAt(row)`), so `getFrameSync` can
 * return data synchronously (it never returns null for a labeled frame).
 *
 * Marked `isSync = true` so `batchLoadLazyFrames` takes the worker-free path.
 *
 * `trackOccupancy` (phase-5): populated SPARSELY per camera by
 * `_computeSparseOccupancy` — one O(nInstances) pass over the columnar store emits
 * per-track run-segments (`{ sparse:true, nTracks, nFrames, segments:Map<trackIdx,
 * [{start,end}]>, counts:Map<trackIdx,frameCount> }`), never a dense
 * nFrames×nTracks grid (which for ~1000s of track fragments would be huge). The
 * timeline reads the `sparse` flag to take a segment branch and caps the rows it
 * renders (first-N per camera by appearance) so a pathological track count can't
 * blow up the canvas. See `ui/timeline.js:_buildTrackSegments`.
 *
 * Track indices: every camera's store is re-indexed into ONE track list,
 * `trackNames`, the union of the cameras' own track names
 * (`loading/track-union.js`) — see `_unifyTracks`.
 *
 * Node order: every camera's store is re-ordered into the session skeleton's
 * node order when its file lists the same nodes in another order, and a camera
 * with different nodes is reported in `nodeOrderMismatches` — see
 * `_unifyNodeOrder` (`loading/slp-skeleton.js`).
 */

import { unionTrackNames } from './track-union.js?v=793ec38e492e';
import { nodeOrderRemap, permuteStoreNodeRows } from './slp-skeleton.js?v=793ec38e492e';

/**
 * `deleteInstanceRows` moves surviving rows with one `copyWithin` per run when
 * at most this many rows go, element by element otherwise. Measured on 2.7M rows
 * x 10 columns: runs ~5 ms for a single delete vs ~70 ms for the loop, and the
 * loop wins once runs get short and numerous.
 */
var DELETE_RUN_COPY_MAX = 4096;

/**
 * Adapt a materialized sleap-io.js typed Instance/PredictedInstance into the flat
 * instance dict the lazy consumers expect: `{ trackIdx, score, type, points,
 * occluded }`. Mirrors `_typedInstanceToSlpData` (import-export/file-io.js) but
 * reads the public per-point API (`point.xy` / `point.visible`). Occlusion =
 * coordinates present but the visible flag is false.
 *
 * @param {Object} inst - typed Instance or PredictedInstance
 * @param {Array} typedTracks - labels.tracks (for indexOf)
 * @param {number} numNodes - skeleton node count
 * @param {Function} PredictedInstance - the class, for the instanceof test
 */
function adaptTypedInstance(inst, typedTracks, numNodes, PredictedInstance) {
    var isPred = PredictedInstance && inst instanceof PredictedInstance;
    // inst.track === null → indexOf returns -1 (trackless sentinel).
    var trackIdx = inst.track ? typedTracks.indexOf(inst.track) : -1;
    var score = isPred ? (inst.score || 0) : 0;

    var pts = inst.points || [];
    var points = new Array(numNodes);
    var occluded = new Array(numNodes);
    for (var k = 0; k < numNodes; k++) {
        var pt = pts[k];
        var xy = pt ? pt.xy : null;
        var x = xy ? xy[0] : NaN;
        var y = xy ? xy[1] : NaN;
        if (isFinite(x) && isFinite(y)) {
            points[k] = [x, y];
            occluded[k] = !(pt && pt.visible);
        } else {
            points[k] = null;
            occluded[k] = false;
        }
    }
    return {
        trackIdx: trackIdx,
        score: score,
        type: isPred ? 'predicted' : 'user',
        points: points,
        occluded: occluded,
    };
}

export class SioLazyLoader {
    constructor() {
        /** @type {Map<string, Object>} camName -> lazy sleap-io.js Labels */
        this.labelsByCam = new Map();
        /**
         * camName -> the `File`/`Blob` this camera was opened from. A local-disk
         * `File` is a cheap lazy handle (not a resident copy of the bytes), so
         * retaining these costs ~nothing and lets a caller re-open a fresh
         * `SioLazyLoader` for the SAME cameras later (e.g. the multi-session
         * streaming save's pass-2 restream, after pass-1 evicted this loader's
         * parsed columnar data — see `saveAllSessionsStreaming` in save-load.js).
         */
        this.sourceFiles = new Map();
        /** @type {Map<string, Map<number, number>>} camName -> (videoFrameIdx -> store row) */
        this.frameRowByCam = new Map();
        /** @type {Map<string, number>} camName -> node count */
        this.numNodesByCam = new Map();

        // LRU cache of adapted frame data: frameIdx -> Map<camName, instances[]>
        this.cache = new Map();
        this.cacheOrder = [];
        this.maxCacheSize = 100;
        this.prefetchAhead = 20;
        // FIFO cap applied to each camera's sleap-io.js lazy `Labels` internal
        // typed-frame cache via the public `frameCacheLimit` (set in open()).
        this.internalFrameCacheLimit = 512;

        this.nFrames = 0;
        this.skeleton = null;
        /** The camera `skeleton` was taken from (the first BY NAME that has one). */
        this.skeletonCam = null;
        /**
         * The session track list: the union of every `open()`ed camera's own
         * track names (`loading/track-union.js`), rebuilt after each open. Each
         * camera's store is rewritten to index THIS list (see `_unifyTracks`).
         */
        this.trackNames = [];
        /**
         * camName -> { names, toSession }: the camera's OWN track names (as read
         * from its file, or as last rewritten by `remapTracksFromIdentity`) and
         * the session index each one currently holds in `trackNames` — i.e. the
         * value its rows carry in `instancesData.track`. Only `open()` adds to
         * it; `openProjectSlp`'s one shared store already has one list.
         */
        this._trackSourceByCam = new Map();
        /** camName -> skeleton dict, so `skeleton` is chosen by camera name, not by I/O timing. */
        this._skeletonByCam = new Map();
        /** camName -> the node names its store's point rows are CURRENTLY in (see `_unifyNodeOrder`). */
        this._nodeOrderByCam = new Map();
        /**
         * camName -> `{ missing, extra }` for every opened camera whose file's
         * nodes are not the session skeleton's (so no by-name remap exists).
         * Rebuilt after each open; the folder loader reports it.
         */
        this.nodeOrderMismatches = new Map();
        /**
         * True once a store has been edited IN MEMORY (`remapTracksFromIdentity`,
         * `deleteInstanceRows`) — i.e. the columns no longer match the source
         * files. The multi-session save's pass 2 re-opens those files, so it
         * keeps this loader's frame + instance columns from pass 1 when set
         * (`commitSessionForMultiSessionSave`, import-export/save-load.js).
         * `_unifyTracks`' load-time re-index does NOT set it: a re-open repeats it.
         */
        this._storeEditedInMemory = false;
        // Embedded calibration recovered from a project .slp's sessions_json
        // (raw calibration dict + camcorder→video map), used by the session
        // builder when the folder has no separate calibration.toml.
        this.calibration = null;
        this.camcorderToVideoMap = null;
        // camName → native store video id (only set by openProjectSlp; the
        // per-camera open() path has one single-video store per camera).
        this.videoIdByCam = null;
        this.videos = new Map();
        this.trackOccupancy = new Map(); // left empty (see file header)

        this.isSync = true; // batchLoadLazyFrames worker-free discriminator
    }

    /**
     * Open one camera's `.slp` lazily and record its metadata. Callers open
     * every camera in PARALLEL, so nothing here may depend on which open
     * finishes first: the skeleton is the one of the first camera BY NAME that
     * has one, and `trackNames` is the union of every opened camera's tracks,
     * with each camera's store re-indexed into it (`_unifyTracks`). The result
     * is the same for any resolution order — including a later re-open of the
     * same files (`reopenSessionLazyLoader`, the multi-session save's pass 2).
     */
    async open(cameraName, file, onProgress) {
        var SIO = window.SleapIO;
        if (!SIO || typeof SIO.readSlpStreaming !== 'function') {
            throw new Error('sleap-io.js readSlpStreaming not available on window.SleapIO');
        }
        // Point the reader's internal I/O worker at LUCID's local vendored h5wasm
        // IIFE (document.baseURI keeps this correct on sub-path deployments).
        var h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js?v=793ec38e492e', document.baseURI).href;
        var labels = await SIO.readSlpStreaming(file, {
            lazy: true,
            openVideos: false,
            // Capture the verbatim sessions_json so we can recover the embedded
            // calibration a LUCID project .slp carries (see this.calibration) —
            // without it the session-folder loader falls back to placeholder
            // identity cameras and the user's calibration is silently lost
            // (#134 / eric/fix-save).
            rawSessions: true,
            h5wasmUrl: h5wasmUrl,
            onProgress: onProgress
                ? function (n, total, msg) { onProgress(msg || ('Reading ' + n + '/' + total)); }
                : undefined,
        });
        this.labelsByCam.set(cameraName, labels);
        this.sourceFiles.set(cameraName, file);

        // Capture the embedded per-camera calibration from the first opened file
        // that carries one (a project .slp saved by LUCID does; a raw prediction
        // .slp usually does not). Stored as the raw sessions_json calibration
        // dict ({ cam_0: {name, matrix, rotation, translation, distortions,
        // size}, … }) plus the camcorder→video map; the session builder turns
        // these into real Camera objects when no calibration.toml is present.
        if (!this.calibration) {
            var rawSess = (labels.rawSessionsJson && labels.rawSessionsJson[0]) || null;
            if (rawSess && rawSess.calibration) {
                var calKeys = Object.keys(rawSess.calibration).filter(function (k) { return k !== 'metadata'; });
                if (calKeys.length > 0) {
                    this.calibration = rawSess.calibration;
                    this.camcorderToVideoMap = rawSess.camcorder_to_video_idx_map || null;
                }
            }
        }

        // Bound the reader's internal typed-frame cache via the public API
        // (`frameCacheLimit` FIFO-evicts beyond the cap) so long scrubbing and
        // windowed export/triangulate sweeps don't accumulate every materialized
        // frame. Replaces the old manual reach-in into `labels._lazyFrameList.cache`.
        try { labels.frameCacheLimit = this.internalFrameCacheLimit; } catch (e) { /* older bundle */ }

        var skel = labels.skeletons && labels.skeletons[0];
        this._skeletonByCam.set(cameraName, skel ? {
            name: skel.name || 'skeleton',
            nodes: skel.nodeNames,
            edges: skel.edgeIndices,
        } : null);
        this.skeleton = null;
        this.skeletonCam = null;
        var skelCams = Array.from(this._skeletonByCam.keys()).sort();
        for (var sci = 0; sci < skelCams.length && !this.skeleton; sci++) {
            this.skeleton = this._skeletonByCam.get(skelCams[sci]);
            if (this.skeleton) this.skeletonCam = skelCams[sci];
        }
        this.numNodesByCam.set(cameraName, skel ? skel.nodeNames.length : 0);
        if (skel) this._nodeOrderByCam.set(cameraName, skel.nodeNames.slice());
        this._unifyNodeOrder();

        // Build videoFrameIdx -> store-row map from the columnar frame_idx column,
        // so the app's video frame number resolves to the correct lazy-frame row
        // even if the labeled frames are sparse (unlabeled video frames map to
        // nothing → an empty frame).
        var store = labels._lazyDataStore;
        var frameIdxCol = (store && store.framesData && store.framesData.frame_idx) || [];
        var rowMap = new Map();
        var maxFrameIdx = -1;
        for (var r = 0; r < frameIdxCol.length; r++) {
            var fi = Number(frameIdxCol[r]);
            rowMap.set(fi, r);
            if (fi > maxFrameIdx) maxFrameIdx = fi;
        }
        this.frameRowByCam.set(cameraName, rowMap);
        if (maxFrameIdx + 1 > this.nFrames) this.nFrames = maxFrameIdx + 1;

        // This camera's own tracks, then re-index every camera into the union.
        // The store still holds this file's own indices, so its map starts as
        // the identity. Also computes this camera's sparse occupancy (the
        // Tracks Timeline's presence bars), which must be keyed by SESSION
        // track index and so has to come after the re-index.
        var ownNames = (labels.tracks || []).map(function (t) { return t && t.name != null ? String(t.name) : ''; });
        var ownToSession = new Int32Array(ownNames.length);
        for (var oi = 0; oi < ownToSession.length; oi++) ownToSession[oi] = oi;
        this._trackSourceByCam.set(cameraName, { names: ownNames, toSession: ownToSession });
        this._unifyTracks(cameraName);

        var v = labels.videos && labels.videos[0];
        this.videos.set(cameraName, v ? { filename: v.filename, shape: v.shape } : null);

        return {
            skeleton: this.skeleton,
            // THIS camera's own tracks. The session's list is `this.trackNames`,
            // which is only final once every camera has been opened.
            trackNames: ownNames,
            nFrames: this.nFrames,
            videos: [this.videos.get(cameraName)],
        };
    }

    /**
     * Re-index every `open()`ed camera's store into ONE track list — the union
     * of their own track names, cameras in sorted name order
     * (`unionTrackNames`) — so that `instancesData.track` holds a
     * `trackNames` (= `session.tracks`) index in EVERY camera, which is what
     * every consumer assumes: `adaptTypedInstance`, `forEachInstanceRow`,
     * `_computeSparseOccupancy`, `remapTracksFromIdentity` and the streaming
     * writer, which reads both columns and `labels.tracks` by reference.
     *
     * Runs after EACH open, from the cameras' OWN names (never from a previous
     * union), so the final state is the same whichever order the parallel opens
     * resolve in. For each camera:
     *   - its `labels.tracks` (shared by reference with `_lazyDataStore.tracks`)
     *     is rebuilt IN PLACE to the union, keeping its own `Track` objects at
     *     their new indices — materialization resolves `tracks[id]`, so the
     *     column and the list must change together;
     *   - its track column is rewritten only when its indices move — for the
     *     newly opened camera (whose values are still its file's own indices,
     *     and any value outside its own list must become trackless rather than
     *     come to name an appended track) or when a later camera's names
     *     re-ordered the union. On the real folders every camera's names are
     *     `track_0..track_{n-1}`, every map is the identity, and the only work
     *     is one read pass over the new camera's column;
     *   - its occupancy is recomputed if its column changed, else only its
     *     `nTracks` is updated.
     * Equal name lists in every camera also make the streaming writer's
     * name-signature dedup (`buildSessionRefGraph`) write the tracks ONCE,
     * rather than one copy per camera.
     *
     * @param {string} [newCam] - the camera just opened
     */
    _unifyTracks(newCam) {
        var self = this;
        var cams = Array.from(this._trackSourceByCam.keys());
        var union = unionTrackNames(cams.map(function (c) {
            return { camName: c, names: self._trackSourceByCam.get(c).names };
        }));
        var TrackCtor = window.SleapIO && window.SleapIO.Track;
        var cacheStale = false;
        for (var ci = 0; ci < cams.length; ci++) {
            var cam = cams[ci];
            var src = this._trackSourceByCam.get(cam);
            var next = union.remapByCam.get(cam);
            var labels = this.labelsByCam.get(cam);
            var store = labels && labels._lazyDataStore;
            var tracks = labels && labels.tracks;
            if (!labels || !Array.isArray(tracks)) continue;

            var moved = cam === newCam;
            for (var mi = 0; mi < next.length && !moved; mi++) moved = next[mi] !== src.toSession[mi];

            // 1. Column: current value -> new value, through the old map's inverse.
            var rewritten = 0;
            var col = store && store.instancesData && store.instancesData.track;
            if (moved && col) {
                var step = new Int32Array(tracks.length).fill(-1);
                for (var si = 0; si < src.toSession.length; si++) {
                    if (src.toSession[si] < step.length) step[src.toSession[si]] = next[si];
                }
                var big = typeof BigInt64Array !== 'undefined' && col instanceof BigInt64Array;
                for (var j = 0; j < col.length; j++) {
                    var cur = Number(col[j]);
                    if (!(cur >= 0)) continue;   // trackless (-1/NaN) stays as it is
                    var nv = (cur < step.length && cur === Math.floor(cur)) ? step[cur] : -1;
                    if (nv !== cur) { col[j] = big ? BigInt(nv) : nv; rewritten++; }
                }
            }

            // 2. labels.tracks -> the union, in place, reusing this camera's Track objects.
            var rebuilt = new Array(union.names.length);
            for (var ti = 0; ti < next.length; ti++) {
                var own = src.toSession[ti] < tracks.length ? tracks[src.toSession[ti]] : null;
                if (own) rebuilt[next[ti]] = own;
            }
            for (var ui = 0; ui < rebuilt.length; ui++) {
                if (!rebuilt[ui]) rebuilt[ui] = TrackCtor ? new TrackCtor(union.names[ui]) : { name: union.names[ui] };
            }
            tracks.length = 0;
            for (var pi = 0; pi < rebuilt.length; pi++) tracks.push(rebuilt[pi]);
            src.toSession = next;

            // 3. Occupancy, keyed by session index.
            var occ = this.trackOccupancy.get(cam);
            if (cam === newCam || rewritten > 0) {
                try {
                    var nf = 0;
                    var rm = this.frameRowByCam.get(cam);
                    if (rm) for (var fk of rm.keys()) if (fk + 1 > nf) nf = fk + 1;
                    var fresh = this._computeSparseOccupancy(labels, nf);
                    if (fresh) this.trackOccupancy.set(cam, fresh);
                    else this.trackOccupancy.delete(cam);
                } catch (e) { /* occupancy is optional; ignore */ }
            } else if (occ) {
                occ.nTracks = union.names.length;
            }
            if (rewritten > 0) {
                cacheStale = true;
                if (labels._lazyFrameList && typeof labels._lazyFrameList.clearCache === 'function') {
                    labels._lazyFrameList.clearCache();
                }
                if (cam !== newCam) {
                    console.log('[SioLazyLoader] ' + cam + ': ' + rewritten +
                        ' instance rows re-indexed into the ' + union.names.length + '-track session list');
                }
            }
        }
        if (cacheStale) { this.cache.clear(); this.cacheOrder = []; }
        this.trackNames = union.names;
    }

    /**
     * Re-order every `open()`ed camera's store into the session skeleton's
     * node order (`this.skeleton`, the first camera BY NAME), so each camera's
     * column `i` is the node `this.skeleton.nodes[i]` names. The session has
     * ONE skeleton and every consumer of a lazy store — the materializer, the
     * streaming writer's `appendStore`, `describeStoreFrame` — reads its point
     * rows by POSITION, so a camera whose file lists the same nodes in another
     * order would otherwise have every keypoint drawn, tracked by name and
     * saved under another node's name.
     *
     * Like `_unifyTracks` it runs after EACH open and tracks each store's
     * CURRENT order, so the result is the same whichever order the parallel
     * opens resolve in (a camera that sorts earlier and opens later changes
     * the target, and stores already re-ordered move again), and it is NOT an
     * in-memory edit: a re-open of the same files repeats it. A camera whose
     * nodes differ by NAME is left as read and recorded in
     * `nodeOrderMismatches`; nothing can be remapped there without inventing
     * a correspondence, so the folder loader says so instead.
     *
     * The typed `Skeleton` a re-ordered camera's materialized instances carry
     * keeps the file's order; nothing in LUCID reads it (`adaptTypedInstance`
     * reads points by index).
     */
    _unifyNodeOrder() {
        this.nodeOrderMismatches = new Map();
        var target = this.skeleton && this.skeleton.nodes;
        if (!target || target.length === 0) return;
        var cacheStale = false;
        for (var [cam, current] of this._nodeOrderByCam) {
            var r = nodeOrderRemap(target, current);
            if (r.kind === 'same') continue;
            if (r.kind === 'mismatch') {
                this.nodeOrderMismatches.set(cam, { missing: r.missing, extra: r.extra });
                continue;
            }
            var labels = this.labelsByCam.get(cam);
            var store = labels && labels._lazyDataStore;
            if (!store) continue;
            var moved = permuteStoreNodeRows(store, r.perm);
            this._nodeOrderByCam.set(cam, target.slice());
            if (labels._lazyFrameList && typeof labels._lazyFrameList.clearCache === 'function') {
                labels._lazyFrameList.clearCache();
            }
            cacheStale = true;
            console.log('[SioLazyLoader] ' + cam + ': ' + moved +
                ' instances re-ordered into the session skeleton\'s node order');
        }
        if (cacheStale) { this.cache.clear(); this.cacheOrder = []; }
    }

    /**
     * Open a SINGLE multi-camera project `.slp` lazily (the "Load Project" reopen
     * path) — as opposed to `open()`, which handles one per-camera prediction
     * `.slp` at a time. A LUCID project `.slp` interleaves every camera's video +
     * labeled frames in one file plus a `RecordingSession` (calibration + grouping
     * + 3D). Reopening it eagerly (`parseSlpViaSleapIO`) materializes all frames'
     * 2D (21.7M points on a real cage5 project) and OOMs the tab; this keeps the
     * 2D lazy (materialized per frame on demand) while the caller restores the
     * bounded grouping + 3D from the typed session (see
     * `reconstructInstanceGroupsFromSessionLazy`).
     *
     * Populates the SAME per-camera maps `open()` does (all cameras share the one
     * `labels`; `frameRowByCam` splits the interleaved store by video) so every
     * downstream accessor (`getFrameSync`, `_extractCamFrame`, `releaseFrame`,
     * the streaming save's `refFor`) works unchanged. Returns the open `labels`
     * (with its lazy 2D store + typed `RecordingSession`) for the caller.
     *
     * @param {File} file - the project `.slp`
     * @param {Function} [onProgress] - `(msg) => void`
     * @returns {Promise<{labels:Object, typedSession:Object, cameraNames:string[], nFrames:number}>}
     */
    async openProjectSlp(file, onProgress) {
        var SIO = window.SleapIO;
        if (!SIO || typeof SIO.readSlpStreaming !== 'function') {
            throw new Error('sleap-io.js readSlpStreaming not available on window.SleapIO');
        }
        var h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js?v=793ec38e492e', document.baseURI).href;
        var labels = await SIO.readSlpStreaming(file, {
            lazy: true,
            openVideos: false,
            rawSessions: true, // for embedded calibration + the raw camcorder map
            h5wasmUrl: h5wasmUrl,
            onProgress: onProgress
                ? function (n, total, msg) { onProgress(msg || ('Reading ' + n + '/' + total)); }
                : undefined,
        });
        this._projectLabels = labels;
        // A single project `.slp` interleaves every camera in ONE store, so all
        // `labelsByCam` entries point at the same `labels`/`_lazyDataStore`. The
        // streaming writer must append that shared store ONCE (not per camera) or
        // it duplicates every frame/track — see `buildSessionRefGraph` /
        // `streamSessionIntoWriter` in slp-streaming-write.js.
        this._sharedStore = true;
        try { labels.frameCacheLimit = this.internalFrameCacheLimit; } catch (e) { /* older bundle */ }

        var skel = labels.skeletons && labels.skeletons[0];
        if (skel) {
            this.skeleton = { name: skel.name || 'skeleton', nodes: skel.nodeNames, edges: skel.edgeIndices };
            this.trackNames = (labels.tracks || []).map(function (t) { return t.name; });
        }
        var numNodes = skel ? skel.nodeNames.length : 0;

        // Embedded calibration (raw dict + camcorder→video map), same as open().
        var rawSess = (labels.rawSessionsJson && labels.rawSessionsJson[0]) || null;
        if (!this.calibration && rawSess && rawSess.calibration) {
            var calKeys = Object.keys(rawSess.calibration).filter(function (k) { return k !== 'metadata'; });
            if (calKeys.length > 0) {
                this.calibration = rawSess.calibration;
                this.camcorderToVideoMap = rawSess.camcorder_to_video_idx_map || null;
            }
        }

        // Camera name → video index. Prefer the TYPED session's videoByCamera
        // (authoritative Camera→Video objects); fall back to the raw camcorder map
        // resolved against the calibration camera names.
        var typedSession = (labels.sessions && labels.sessions[0]) || null;
        var camToVid = new Map(); // cameraName → videoIdx
        var videosArr = labels.videos || [];
        if (typedSession && typedSession.videoByCamera && typedSession.videoByCamera.size > 0) {
            for (var camEntry of typedSession.videoByCamera) {
                var camObj = camEntry[0], vidObj = camEntry[1];
                var nm = camObj && camObj.name;
                var vi = videosArr.indexOf(vidObj);
                if (nm != null && vi >= 0) camToVid.set(nm, vi);
            }
        } else if (this.calibration && this.camcorderToVideoMap) {
            var cKeys = Object.keys(this.calibration).filter(function (k) { return k !== 'metadata'; });
            for (var mk in this.camcorderToVideoMap) {
                var vIdx = this.camcorderToVideoMap[mk];
                // Key may be a camcorder index ("0") or a calibration key ("cam_0").
                var cd = this.calibration[mk];
                if (!cd) {
                    var ki = parseInt(String(mk).replace(/[^0-9]/g, ''));
                    if (!isNaN(ki) && cKeys[ki]) cd = this.calibration[cKeys[ki]];
                }
                var camName = (cd && cd.name) || mk;
                if (vIdx != null) camToVid.set(camName, vIdx);
            }
        }
        var vidToCam = new Map();
        for (var cv of camToVid) vidToCam.set(cv[1], cv[0]);
        // Retain camera → NATIVE store video id (the values in the columnar
        // `framesData.video` column). The streaming re-save needs this to remap
        // store video ids onto its own header order instead of assuming they
        // coincide (they do for a LUCID-written file, but not necessarily for a
        // project .slp from Python sleap-io) — see `streamSessionIntoWriter`.
        this.videoIdByCam = camToVid;

        // Split the interleaved store into per-camera videoFrameIdx→storeRow maps.
        var store = labels._lazyDataStore;
        var fd = (store && store.framesData) || {};
        var frameIdxCol = fd.frame_idx || [];
        var videoCol = fd.video || [];
        var maxFrameIdx = -1;
        for (var r = 0; r < frameIdxCol.length; r++) {
            var vid = Number(videoCol[r]);
            var cam = vidToCam.get(vid);
            if (cam == null) continue;
            if (!this.labelsByCam.has(cam)) {
                this.labelsByCam.set(cam, labels);
                this.numNodesByCam.set(cam, numNodes);
                this.frameRowByCam.set(cam, new Map());
                this.sourceFiles.set(cam, file);
                var vobj = videosArr[vid];
                this.videos.set(cam, vobj ? { filename: vobj.filename, shape: vobj.shape } : null);
            }
            var fi = Number(frameIdxCol[r]);
            this.frameRowByCam.get(cam).set(fi, r);
            if (fi > maxFrameIdx) maxFrameIdx = fi;
        }
        this.nFrames = maxFrameIdx + 1;

        // Sparse per-track occupancy for the timeline's presence bars — same
        // as open()'s per-camera call, but every camera here shares ONE
        // interleaved store, so each needs its OWN rowMap passed to scope the
        // scan to just its rows (see _computeSparseOccupancy's doc). Missing
        // entirely until now: reopening an already-saved project via
        // openProjectSlp left the Tracks Timeline with no occupancy data at
        // all for any camera, unlike the per-camera open() path. Best-effort,
        // never blocks the load.
        for (var occCamName of this.labelsByCam.keys()) {
            try {
                var occRowMap = this.frameRowByCam.get(occCamName);
                var occ = this._computeSparseOccupancy(labels, this.nFrames, occRowMap);
                if (occ) this.trackOccupancy.set(occCamName, occ);
            } catch (e) { /* occupancy is optional; ignore */ }
        }

        return {
            labels: labels,
            typedSession: typedSession,
            cameraNames: Array.from(this.labelsByCam.keys()),
            nFrames: this.nFrames,
        };
    }

    /**
     * Compute sparse per-track occupancy for one camera's lazy store — the
     * timeline's presence bars without a dense nFrames×nTracks grid. One pass over
     * the columnar instance table (`instancesData.track`) grouped by frame
     * (`framesData.frame_idx` + `instance_id_start/end`); builds contiguous
     * run-segments per track plus a per-track occupied-frame count (occupancy
     * metadata; the timeline's row cap keeps the earliest-appearing tracks, not the
     * most-occupied). Relies on the SLP on-disk frame ordering, the same invariant
     * `appendStore` assumes. Zero frame materialization.
     *
     * @param {Object} labels    lazy sleap-io.js Labels (with `_lazyDataStore`).
     * @param {number} nFrames   this camera's video frame span (maxFrameIdx + 1).
     * @param {Map<number,number>} [rowMap] - Restricts the scan to THIS camera's
     *   own rows (videoFrameIdx -> store row), required whenever `labels`'s
     *   store is SHARED across multiple cameras (`openProjectSlp` — one
     *   interleaved store, every camera's rows mixed together in file order).
     *   Without it, scanning the whole table would attribute a DIFFERENT
     *   camera's instances/tracks to this one. Omit for the per-camera
     *   `open()` path, where `labels`'s store already belongs to exactly one
     *   camera and every row is valid.
     * @returns {Object|null} `{ sparse, nTracks, nFrames, segments, counts }` or null.
     */
    _computeSparseOccupancy(labels, nFrames, rowMap) {
        var store = labels && labels._lazyDataStore;
        if (!store || !store.framesData) return null;
        var fd = store.framesData;
        var idn = store.instancesData || {};
        var frameIdxCol = fd.frame_idx || fd.frame_id || [];
        var startCol = fd.instance_id_start || [];
        var endCol = fd.instance_id_end || [];
        var trackCol = idn.track || [];
        var nTracks = (labels.tracks || []).length;
        // Row source: either every row in the table (single-camera store) or
        // just this camera's own rows (shared multi-camera store), sorted by
        // frame so the run-length segment logic below (which relies on
        // encountering a track's frames in increasing order) stays correct —
        // a shared store's rows are interleaved across cameras, not sorted
        // per-camera, even though a single-camera store's rows already are.
        var rows;
        if (rowMap) {
            rows = Array.from(rowMap.values());
            // A single camera's own rows are already in on-disk frame order
            // (openProjectSlp scans the shared store's native row order and
            // appends to each camera's map in that same order — the same
            // frame-ordering invariant `appendStore` relies on elsewhere), so
            // sorting is usually a no-op. Verify with one cheap linear pass
            // instead of unconditionally paying an O(n log n) sort — a real
            // cost at 180k+ rows/camera on a large project — and only sort
            // when a row is genuinely out of order.
            var alreadySorted = true;
            for (var ci = 1; ci < rows.length; ci++) {
                if (Number(frameIdxCol[rows[ci]]) < Number(frameIdxCol[rows[ci - 1]])) { alreadySorted = false; break; }
            }
            if (!alreadySorted) {
                rows.sort(function (a, b) { return Number(frameIdxCol[a]) - Number(frameIdxCol[b]); });
            }
        } else {
            rows = frameIdxCol.length;   // sentinel: iterate 0..rows-1 below
        }
        var nRows = rowMap ? rows.length : rows;

        var segments = new Map();   // trackIdx -> [{start,end}]
        var counts = new Map();     // trackIdx -> occupied-frame count
        var open = new Map();       // trackIdx -> {start,last}: the run in progress

        for (var ri = 0; ri < nRows; ri++) {
            var r = rowMap ? rows[ri] : ri;
            var f = Number(frameIdxCol[r]);
            if (!(f >= 0)) continue;
            var s = Number(startCol[r]) || 0;
            var e = Number(endCol[r]) || 0;
            for (var j = s; j < e; j++) {
                var trk = Number(trackCol[j]);
                if (!(trk >= 0)) continue;
                var o = open.get(trk);
                if (o === undefined) {
                    open.set(trk, { start: f, last: f });
                    counts.set(trk, 1);
                } else if (o.last === f) {
                    // Same track twice in one frame — count the frame once.
                } else if (f === o.last + 1) {
                    o.last = f;
                    counts.set(trk, counts.get(trk) + 1);
                } else {
                    // Gap: close the run in progress, open a new one at `f`.
                    var arr = segments.get(trk);
                    if (!arr) { arr = []; segments.set(trk, arr); }
                    arr.push({ start: o.start, end: o.last });
                    o.start = f; o.last = f;
                    counts.set(trk, counts.get(trk) + 1);
                }
            }
        }
        for (var entry of open) {
            var trkF = entry[0], oF = entry[1];
            var arrF = segments.get(trkF);
            if (!arrF) { arrF = []; segments.set(trkF, arrF); }
            arrF.push({ start: oF.start, end: oF.last });
        }
        if (segments.size === 0) return null;
        return { sparse: true, nTracks: nTracks, nFrames: nFrames, segments: segments, counts: counts };
    }

    /** Materialize one camera's instances for a video frame index (synchronous). */
    _extractCamFrame(cameraName, videoFrameIdx) {
        var labels = this.labelsByCam.get(cameraName);
        if (!labels) return [];
        var rowMap = this.frameRowByCam.get(cameraName);
        var row = rowMap ? rowMap.get(videoFrameIdx) : undefined;
        if (row === undefined) return [];
        var lf = labels.frameAt(row);
        if (!lf || !lf.instances) return [];
        var PredictedInstance = window.SleapIO && window.SleapIO.PredictedInstance;
        var typedTracks = labels.tracks || [];
        var numNodes = this.numNodesByCam.get(cameraName) || (this.skeleton ? this.skeleton.nodes.length : 0);
        var out = [];
        for (var i = 0; i < lf.instances.length; i++) {
            out.push(adaptTypedInstance(lf.instances[i], typedTracks, numNodes, PredictedInstance));
        }
        return out;
    }

    /** Build the per-camera instance map for a frame (synchronous under the hood). */
    _buildFrameMap(frameIdx) {
        var frameMap = new Map();
        for (var camName of this.labelsByCam.keys()) {
            frameMap.set(camName, this._extractCamFrame(camName, frameIdx));
        }
        return frameMap;
    }

    /** Async frame fetch (matches LazyFrameLoader.getFrame). */
    async getFrame(frameIdx) {
        if (this.cache.has(frameIdx)) { this._touch(frameIdx); return this.cache.get(frameIdx); }
        var frameMap = this._buildFrameMap(frameIdx);
        this._put(frameIdx, frameMap);
        return frameMap;
    }

    /**
     * Synchronous frame fetch. Unlike LazyFrameLoader (worker-backed, returns
     * null when not yet cached), this materializes on demand and always returns a
     * Map for a valid frame index — cheap because only the requested frame's
     * objects are built.
     */
    getFrameSync(frameIdx) {
        if (this.cache.has(frameIdx)) { this._touch(frameIdx); return this.cache.get(frameIdx); }
        if (frameIdx < 0 || frameIdx >= this.nFrames) return null;
        var frameMap = this._buildFrameMap(frameIdx);
        this._put(frameIdx, frameMap);
        return frameMap;
    }

    prefetch(frameIdx, direction) {
        var start = direction > 0 ? frameIdx + 1 : Math.max(0, frameIdx - this.prefetchAhead);
        var end = direction > 0 ? Math.min(this.nFrames, frameIdx + this.prefetchAhead + 1) : frameIdx;
        for (var fi = start; fi < end; fi++) {
            if (!this.cache.has(fi)) this.getFrameSync(fi);
        }
    }

    _touch(frameIdx) {
        var idx = this.cacheOrder.indexOf(frameIdx);
        if (idx >= 0) this.cacheOrder.splice(idx, 1);
        this.cacheOrder.push(frameIdx);
    }

    _put(frameIdx, data) {
        if (this.cache.has(frameIdx)) { this._touch(frameIdx); return; }
        this.cache.set(frameIdx, data);
        this.cacheOrder.push(frameIdx);
        while (this.cacheOrder.length > this.maxCacheSize) {
            this.cache.delete(this.cacheOrder.shift());
        }
    }

    /**
     * Release one frame from BOTH retention layers so a bounded windowed sweep
     * (streaming export / triangulate-all) stays memory-bounded:
     *   1. this.cache — our adapted-dict LRU (already capped at maxCacheSize).
     *   2. each camera's underlying sleap-io.js lazy `Labels` typed-frame cache,
     *      via the public `labels.releaseFrame(row)` API (frame row = this
     *      camera's videoFrameIdx→store-row map). `store.materializeFrame` rebuilds
     *      the typed frame on next access, so dropping it is safe.
     * (`frameCacheLimit`, set in open(), also FIFO-bounds layer 2 automatically;
     * releaseFrame is the explicit prompt-release used by windowed sweeps.)
     */
    releaseFrame(frameIdx) {
        if (this.cache.has(frameIdx)) {
            this.cache.delete(frameIdx);
            var oi = this.cacheOrder.indexOf(frameIdx);
            if (oi >= 0) this.cacheOrder.splice(oi, 1);
        }
        for (var camName of this.labelsByCam.keys()) {
            var labels = this.labelsByCam.get(camName);
            if (!labels || typeof labels.releaseFrame !== 'function') continue;
            var rowMap = this.frameRowByCam.get(camName);
            var row = rowMap ? rowMap.get(frameIdx) : undefined;
            if (row !== undefined) labels.releaseFrame(row);
        }
    }

    /** Release a half-open window [startFrameIdx, endFrameIdx) of frames. */
    releaseWindow(startFrameIdx, endFrameIdx) {
        for (var f = startFrameIdx; f < endFrameIdx; f++) this.releaseFrame(f);
    }

    /**
     * Read-only sweep over every (camera, frameIdx, trackIdx) instance triple
     * in the WHOLE project, straight from each camera's columnar store
     * (`labels._lazyDataStore.framesData`/`.instancesData`) — no frame or
     * instance object materialization, independent of what's currently
     * resident/cached. Used by project-wide identity/track propagation
     * (`Session.propagateTracksToIdentities`, pose/pose-data.js) so it isn't
     * limited to whatever's in `session.frameGroups` (a lazy session's small
     * resident window).
     * @param {(camName: string, frameIdx: number, trackIdx: number, info: {offsetInFrame: number, storeRow: number, instanceRow: number, type: string}) => void} visitFn
     *   `trackIdx` is -1 for a trackless instance. `info` is a 4th argument added
     *   for Custom Instance Delete's session-wide scope, which has to filter by
     *   type and address rows by their in-frame offset WITHOUT hydrating any
     *   frame: `offsetInFrame` is the value an `Instance._rawInstIndex` carries,
     *   and `type` is `'predicted'`/`'user'` decoded from `instance_type`
     *   (1 = predicted, matching `appendStore`). Pre-existing callers take three
     *   parameters and are unaffected.
     * @param {{camera?: string, start?: number, end?: number}} [opts] - Narrow
     *   the walk, for the status bar's per-camera counters
     *   (`ui/frame-counters.js`), which read ONE camera and spread a
     *   whole-project walk over several short tasks. `camera` visits that
     *   camera's rows only. `start`/`end` (frame indices, end exclusive) visit
     *   just that range, in ascending frame order; without them every frame is
     *   visited in the row map's own order, as before.
     */
    forEachInstanceRow(visitFn, opts) {
        var onlyCamera = opts && opts.camera != null ? opts.camera : null;
        var ranged = !!opts && opts.start != null && opts.end != null;
        for (var camName of this.labelsByCam.keys()) {
            if (onlyCamera !== null && camName !== onlyCamera) continue;
            var labels = this.labelsByCam.get(camName);
            var store = labels && labels._lazyDataStore;
            var rowMap = this.frameRowByCam.get(camName);
            if (!store || !rowMap) continue;
            var fd = store.framesData || {};
            var idn = store.instancesData || {};
            var visitFrame = function (frameIdx, frameRow) {
                var iStart = Number(fd.instance_id_start ? fd.instance_id_start[frameRow] : 0) || 0;
                var iEnd = Number(fd.instance_id_end ? fd.instance_id_end[frameRow] : 0) || 0;
                for (var j = iStart; j < iEnd; j++) {
                    var trk = idn.track ? Number(idn.track[j]) : -1;
                    if (!Number.isFinite(trk)) trk = -1;
                    visitFn(camName, frameIdx, trk, {
                        offsetInFrame: j - iStart,
                        storeRow: frameRow,
                        instanceRow: j,
                        type: (idn.instance_type && Number(idn.instance_type[j]) === 1) ? 'predicted' : 'user',
                    });
                }
            };
            if (ranged) {
                for (var f = Math.max(0, opts.start); f < opts.end; f++) {
                    var r = rowMap.get(f);
                    if (r !== undefined) visitFrame(f, r);
                }
            } else {
                for (var [frameIdx, frameRow] of rowMap) visitFrame(frameIdx, frameRow);
            }
        }
    }

    /**
     * What re-hydrating one camera-frame from the store WOULD produce, read
     * straight from the columns — no frame or instance is materialized. The
     * playback eviction (`pose/lazy-residency.js`) compares a resident
     * FrameGroup against this to prove it is rebuildable before dropping it.
     *
     * Entry `k` is the store instance at in-frame offset `k`, i.e. the row an
     * `Instance._rawInstIndex` of `k` names. Mirrors what `_extractCamFrame`
     * (via the store's `materializeFrame` + `adaptTypedInstance`) would build:
     *   - `trackIdx[k]`: the session track index, or -1 for trackless. A track
     *     id with no `Track` behind it is trackless there too.
     *   - `predicted[k]`: 1 unless `instance_type` is 0 (a user instance).
     *
     * @param {string} camName
     * @param {number} frameIdx - video frame index
     * @returns {{count: number, trackIdx: Int32Array, predicted: Uint8Array}|null}
     *   null when this loader does not back `camName` at all (the caller must
     *   then treat that camera's data as NOT rebuildable). A camera with no row
     *   for this frame reports `count: 0`.
     */
    describeStoreFrame(camName, frameIdx) {
        var labels = this.labelsByCam.get(camName);
        var rowMap = this.frameRowByCam.get(camName);
        var store = labels && labels._lazyDataStore;
        if (!store || !rowMap) return null;
        var row = rowMap.get(frameIdx);
        if (row === undefined) return { count: 0, trackIdx: new Int32Array(0), predicted: new Uint8Array(0) };
        var fd = store.framesData || {};
        var idn = store.instancesData || {};
        var iStart = Number(fd.instance_id_start ? fd.instance_id_start[row] : 0) || 0;
        var iEnd = Number(fd.instance_id_end ? fd.instance_id_end[row] : 0) || 0;
        var n = Math.max(0, iEnd - iStart);
        // `materializeFrame` resolves the column against the STORE's list and
        // `adaptTypedInstance` takes `indexOf` in `labels.tracks`. They are one
        // array (see `_unifyTracks`), in which case the id IS the index — a
        // duplicated Track object would make `indexOf` smaller, which reads here
        // as a mismatch, i.e. "not rebuildable": the safe direction.
        var storeTracks = store.tracks || labels.tracks || [];
        var labelTracks = labels.tracks || [];
        var sameList = storeTracks === labelTracks;
        var trackIdx = new Int32Array(n);
        var predicted = new Uint8Array(n);
        for (var k = 0; k < n; k++) {
            var j = iStart + k;
            // Same defaults as `materializeFrame`: an absent track is -1, an
            // absent type is 0 (a user instance).
            var rawTrack = idn.track ? idn.track[j] : undefined;
            var tid = Number(rawTrack == null ? -1 : rawTrack);
            var t = tid >= 0 ? storeTracks[tid] : null;
            trackIdx[k] = !t ? -1 : (sameList ? tid : labelTracks.indexOf(t));
            var rawType = idn.instance_type ? idn.instance_type[j] : undefined;
            predicted[k] = Number(rawType == null ? 0 : rawType) === 0 ? 0 : 1;
        }
        return { count: n, trackIdx: trackIdx, predicted: predicted };
    }

    /**
     * Rewrite every camera's persistent columnar track assignment to match a
     * new identity-derived track list, so the change survives eviction/reload
     * and is picked up natively by SLP export — `appendStore` reads
     * `instancesData.track` by reference (see import-export/slp-streaming-
     * write.js) — without materializing a single extra frame. Companion to
     * `forEachInstanceRow`; used by `Session.propagateIdentitiesToTracks`
     * ("Propagate IDs → Tracks").
     *
     * Each underlying `labels` object's `tracks` array (shared by reference
     * with its `_lazyDataStore.tracks` — mutated in place, never reassigned,
     * so both stay in sync) is rebuilt to exactly `newTrackNames`; a shared
     * store (one project `.slp` interleaving multiple cameras, see
     * `openProjectSlp`) is only rebuilt once even though several camera names
     * point at the same `labels`.
     *
     * @param {string[]} newTrackNames - the new project-wide track name list
     *   (mirrors `session.tracks` after propagate).
     * @param {(camName: string, frameIdx: number, oldTrackIdx: number, offsetInFrame: number) => number} remapFn
     *   Returns the new track index (into `newTrackNames`), or a negative
     *   number for "no track."
     *
     *   `offsetInFrame` is the row's index WITHIN its camera-frame (the same
     *   quantity `forEachInstanceRow` reports under that name), and it is what
     *   makes a *per-row* decision possible. Without it a caller can only key on
     *   `oldTrackIdx`, so when one camera's raw tracker gives two different
     *   animals the SAME trackIdx on a frame there is no answer that is right for
     *   both rows and both had to be abandoned as trackless — luc3d #203, whose
     *   symptom is a gap in the first frames of a project (where
     *   `commitTrackedFrame` writes its ambiguity markers). It matches
     *   `InstanceGroup` members' `_rawInstIndex`, so a caller holding the
     *   grouping can resolve each row exactly.
     * @returns {{changed: number, errorRows: number, firstError: Error|null}}
     *   `changed` is instance rows whose track id actually changed;
     *   `errorRows`/`firstError` surface any per-row failures (see the
     *   diagnostic note above) instead of silently swallowing them.
     */
    remapTracksFromIdentity(newTrackNames, remapFn) {
        var SIO = window.SleapIO;
        var TrackCtor = SIO && SIO.Track;
        var changed = 0;
        // Regression diagnostic (see "only the first frame(s) have tracks after
        // export" report): this function used to have NO error handling at all
        // — an exception thrown mid-row would silently abort the rest of the
        // ENTIRE remap for every camera not yet processed, while the live
        // session (frameIdentityMap/instanceGroups/resident Instance.trackIdx,
        // all mutated BEFORE this function runs) would already look completely
        // correct in the GUI. That mismatch — correct on screen, broken in the
        // export — is exactly what silently swallowing an error here would
        // produce. `errorRows`/`firstError` surface any such failure instead of
        // eating it; `propagateIdentitiesToTracks` reports both in its status.
        var errorRows = 0;
        var firstError = null;
        var rebuiltLabels = new Set();   // labels whose .tracks array was rebuilt
        var seenLabels = new Set();      // every labels object touched (cache-clear target)
        for (var camName of this.labelsByCam.keys()) {
            var labels = this.labelsByCam.get(camName);
            var store = labels && labels._lazyDataStore;
            var rowMap = this.frameRowByCam.get(camName);
            if (!store || !rowMap) continue;
            seenLabels.add(labels);

            if (TrackCtor && !rebuiltLabels.has(labels)) {
                rebuiltLabels.add(labels);
                var tracksArr = store.tracks;   // === labels.tracks (shared ref)
                if (Array.isArray(tracksArr)) {
                    tracksArr.length = 0;
                    for (var t = 0; t < newTrackNames.length; t++) {
                        tracksArr.push(new TrackCtor(newTrackNames[t]));
                    }
                }
            }
            // Every camera now indexes `newTrackNames` directly, so that is its
            // own list from here on (a later `_unifyTracks` must start from it,
            // not from the file's pre-propagate names).
            var srcAfter = this._trackSourceByCam.get(camName);
            if (srcAfter) {
                var idAfter = new Int32Array(newTrackNames.length);
                for (var ia = 0; ia < idAfter.length; ia++) idAfter[ia] = ia;
                srcAfter.names = newTrackNames.map(String);
                srcAfter.toSession = idAfter;
            }

            var fd = store.framesData || {};
            var idn = store.instancesData || {};
            if (!idn.track) continue;
            // Per-camera diagnostic counters (see the note above this method) —
            // logged after this camera's loop so a scan of the console
            // immediately shows whether coverage suspiciously drops to ~0 for
            // some camera/frame range instead of scaling with the columnar
            // store's actual row count.
            var camRowsVisited = 0;
            var camRowsChanged = 0;
            for (var [frameIdx, frameRow] of rowMap) {
                var iStart = Number(fd.instance_id_start ? fd.instance_id_start[frameRow] : 0) || 0;
                var iEnd = Number(fd.instance_id_end ? fd.instance_id_end[frameRow] : 0) || 0;
                for (var j = iStart; j < iEnd; j++) {
                    camRowsVisited++;
                    // Isolated per-row: one malformed row/frame must not abort
                    // the remap for every frame after it (see the diagnostic
                    // note above this method).
                    try {
                        var oldTrk = Number(idn.track[j]);
                        if (!Number.isFinite(oldTrk)) oldTrk = -1;
                        var newTrk = remapFn(camName, frameIdx, oldTrk, j - iStart);
                        newTrk = (newTrk == null || newTrk < 0) ? -1 : newTrk;
                        if (idn.track[j] !== newTrk) { idn.track[j] = newTrk; changed++; camRowsChanged++; }
                    } catch (rowErr) {
                        errorRows++;
                        if (!firstError) firstError = rowErr;
                        if (errorRows <= 5) {
                            console.error('[remapTracksFromIdentity] row ' + j + ' (camera=' + camName +
                                ', frame=' + frameIdx + ') failed — leaving its track unchanged:', rowErr);
                        }
                    }
                }
            }
            console.log('[remapTracksFromIdentity] camera=' + camName + ': ' + camRowsChanged + '/' +
                camRowsVisited + ' rows remapped (rest already matched, or had no identity to remap to).');

            // Rebuild THIS camera's sparse track-occupancy from the just-
            // remapped column. `session.trackOccupancy` is the SAME Map
            // object as `this.trackOccupancy` (set by reference in
            // session-loader.js), so replacing this entry is picked up by the
            // Timeline with no extra wiring. Without this, `_computeSparseOccupancy`'s
            // one-time snapshot from `open()` keeps describing the
            // PRE-propagate track ids forever, and `ui/timeline.js:
            // _buildTrackSegments` trusts it for every frame the user hasn't
            // scrubbed to — the "Tracks Timeline doesn't update after
            // Propagate IDs → Tracks" bug.
            try {
                // Pass THIS camera's rowMap — required for a shared-store
                // project (openProjectSlp, multiple cameras -> one `labels`);
                // without it the scan would mix every camera's rows together
                // (see _computeSparseOccupancy's doc). Harmless/no-op change
                // for a per-camera open() store, where every row already
                // belongs to this camera.
                var newOcc = this._computeSparseOccupancy(labels, this.nFrames, rowMap);
                if (newOcc) this.trackOccupancy.set(camName, newOcc);
                else this.trackOccupancy.delete(camName);
            } catch (e) { /* occupancy is optional; ignore */ }
        }

        // Invalidate every resident cache layer — our own adapted-dict LRU
        // and each camera's underlying sleap-io.js typed-frame cache — so a
        // currently-cached or later-revisited frame re-materializes from the
        // just-mutated columns instead of serving stale trackIdx values
        // (adaptTypedInstance/`materializeFrame` both resolve trackIdx from
        // `tracks`/`instancesData.track` fresh on each materialization, so
        // simply dropping the cached copies is sufficient — no rebuild here).
        //
        // Reaches into `_lazyFrameList.clearCache()` (drops the WHOLE cache
        // in one call) instead of the public per-row `releaseFrame(row)` API
        // looped over every frame in the project: for a 180k-frame x 5-camera
        // project that loop was up to ~900k calls just to invalidate what's
        // normally a few hundred cached entries (`internalFrameCacheLimit`)
        // — the dominant cost in the "Propagate IDs -> Tracks takes forever"
        // report. Falls back to the old per-row loop on an older bundle
        // without `clearCache`.
        this.cache.clear();
        this.cacheOrder = [];
        for (var labels2 of seenLabels) {
            if (labels2._lazyFrameList && typeof labels2._lazyFrameList.clearCache === 'function') {
                labels2._lazyFrameList.clearCache();
            } else if (typeof labels2.releaseFrame === 'function') {
                for (var camName2 of this.labelsByCam.keys()) {
                    if (this.labelsByCam.get(camName2) !== labels2) continue;
                    var rowMap2 = this.frameRowByCam.get(camName2);
                    if (!rowMap2) continue;
                    for (var frameRow2 of rowMap2.values()) labels2.releaseFrame(frameRow2);
                }
            }
        }
        this.trackNames = newTrackNames.map(String);
        if (changed > 0 || rebuiltLabels.size > 0) this._storeEditedInMemory = true;
        if (errorRows > 0) {
            console.error('[remapTracksFromIdentity] ' + errorRows + ' row(s) failed and were left with their ' +
                'OLD (now likely out-of-range) track index — those rows will show as trackless once ' +
                'session.tracks is replaced with the shorter identity-derived list. First error:', firstError);
        }
        return { changed: changed, errorRows: errorRows, firstError: firstError };
    }

    /**
     * Permanently remove instance rows from the persistent columnar store, so a
     * bulk delete SURVIVES eviction, re-hydration, save and reload. Companion
     * to `remapTracksFromIdentity` (same durability contract, same diagnostics),
     * built for the Custom Instance Delete dialog.
     *
     * ## Why this has to exist
     *
     * Deleting from `session.frameGroups`/`session.instanceGroups` alone is not
     * a delete on a lazy project — it fails in TWO independent ways:
     *
     *  1. **Without even saving.** `finalizeLazyFrameGroup` (pose/triangulation
     *     .js) re-derives `fg.instances` from the store rows on every hydration
     *     and puts any row with no matching `_rawInstIndex` member into the
     *     UNLINKED pool. Scrub away and back and the instance is simply there
     *     again, now ungrouped.
     *  2. **On save.** The streaming writer ends in `appendStore`, which copies
     *     the columns VERBATIM and has no per-instance filter or skip hook. Its
     *     only escape hatch is LUCID's user-correction overlay, which skips any
     *     camera-frame with no resident *user* instance and bails outright on
     *     `lucidInsts.length === 0` — so an emptied camera-frame streams back
     *     unchanged.
     *
     * Mutating the store fixes both at once, and is the only thing that does.
     *
     * ## What is and is not compacted
     *
     * `instancesData` columns are compacted; `pointsData`/`predPointsData` are
     * deliberately LEFT ALONE. `appendStore` walks points PER SURVIVING
     * INSTANCE (`[point_id_start[j], point_id_end[j])`) into a freshly-sized
     * output buffer, so orphaned point rows are never visited and never written
     * — compacting them would be pure risk for zero file-size benefit.
     *
     * Frame rows are NOT removed either: `frameRowByCam` is keyed by row index
     * and `refFor`, `releaseFrame` and `_computeSparseOccupancy` all depend on
     * that indexing. A frame whose range collapses to `start === end` is written
     * by `appendStore` as an empty `LabeledFrame`, which is exactly right (and
     * is LUCID's answer to SLEAP's "empty LabeledFrames are removed").
     *
     * Row renumbering uses a prefix sum (`survBefore`) rather than assuming
     * frame rows are sorted by `instance_id_start`, so it is order-independent:
     * the new index of surviving old row `i` is `survBefore[i]`, and a frame's
     * new range is `[survBefore[oldStart], survBefore[oldEnd])`.
     *
     * `from_predicted` is remapped through the same table, degrading a link
     * whose target was deleted to `-1` — mirroring what `appendStore`'s own
     * `outIdxOf` already does for rows skipped by the overlay.
     *
     * ## Cost: one keypress, not one bulk operation
     *
     * Every interactive Delete goes through here too (`ui/interaction.js`
     * `_deleteSelected`, via `deleteTargetsFromStore`), so a single-row delete
     * must not cost what a whole-project one does. Measured on a real-size
     * shared store (180,210 frames x 5 cameras, 2.7M instance rows) it used to
     * be 130-200 ms and ~216 MB of fresh column buffers per keypress, from three
     * whole-project passes. Each is now bounded by what was deleted:
     *  - `opts.only` walks just the named (camera, frame) rows instead of
     *    calling `shouldDeleteFn` on all 2.7M;
     *  - columns are compacted IN PLACE from the first deleted row (rows before
     *    it do not move) and re-exposed as a shorter `subarray` view — no new
     *    buffer, unless more than half the rows went, when a right-sized copy
     *    gives the memory back as the old fresh-array compaction did;
     *  - track occupancy is rebuilt only for a camera that LOST a row. On a
     *    shared store every camera's ranges shift, but a camera's occupancy is
     *    its frames' track values, which only its own deletions change.
     * In place is safe because every reader indexes `store.instancesData.<col>`
     * element-wise and fresh (`appendStore`, the store's own `materializeFrame`,
     * `forEachInstanceRow`); nothing holds a column across a delete.
     *
     * CALLER CONTRACT: this only touches the store. The caller must also
     * renumber `_rawInstIndex` on every surviving resident/group instance in
     * each touched (camera, frame) — otherwise `refFor` writes grouping refs
     * pointing at the wrong instances and hydration loads the wrong 2D — and
     * mirror the removal into `frameGroups`/`instanceGroups` under one shared
     * `seen` Set. See `ui/custom-delete-ops.js`.
     *
     * @param {(camName: string, frameIdx: number, offsetInFrame: number, storeRow: number) => boolean} shouldDeleteFn
     *   Called once per instance row per camera. `offsetInFrame` is the row's
     *   position within its (camera, frame) list — i.e. the value an
     *   `Instance._rawInstIndex` would carry.
     * @param {{only?: Map<string, Map<number, *>|Set<number>>}} [opts]
     *   `only` — camName -> the frame indices (a Map's keys or a Set) whose rows
     *   may be deleted. `shouldDeleteFn` is then called for those camera-frames'
     *   rows ONLY; a camera or frame not named is never visited. Purely a
     *   narrowing of the walk: the predicate still decides every row.
     * @returns {{deleted: number, errorRows: number, firstError: Error|null, byCamera: Object.<string, number>}}
     */
    deleteInstanceRows(shouldDeleteFn, opts) {
        var only = opts && opts.only ? opts.only : null;
        var deleted = 0;
        var errorRows = 0;
        var firstError = null;
        var byCamera = {};
        var seenLabels = new Set();

        // Group cameras by their underlying `labels`. A SHARED store (one
        // project .slp interleaving every camera — `openProjectSlp`, where
        // `_sharedStore === true`) must be compacted EXACTLY ONCE even though
        // several camera names point at the same object; compacting per camera
        // would renumber already-renumbered rows and shred the file. This is
        // the deletion analogue of `remapTracksFromIdentity`'s `rebuiltLabels`
        // guard, but it has to cover the WHOLE mutation here, not just a
        // one-time tracks rebuild, because compaction is global to a store.
        var camsByLabels = new Map();
        for (var camName of this.labelsByCam.keys()) {
            var labelsForCam = this.labelsByCam.get(camName);
            if (!labelsForCam || !labelsForCam._lazyDataStore) continue;
            if (!this.frameRowByCam.get(camName)) continue;
            if (!camsByLabels.has(labelsForCam)) camsByLabels.set(labelsForCam, []);
            camsByLabels.get(labelsForCam).push(camName);
        }

        for (var [labels, camNames] of camsByLabels) {
            var store = labels._lazyDataStore;
            var fd = store.framesData || {};
            var idn = store.instancesData || {};
            var typeCol = idn.instance_type || idn.point_id_start;
            var nInst = (typeCol && typeof typeCol.length === 'number') ? typeCol.length : 0;
            var frameCol = fd.frame_id || fd.video;
            var nFrameRows = (frameCol && typeof frameCol.length === 'number') ? frameCol.length : 0;
            if (!nInst || !nFrameRows || !fd.instance_id_start || !fd.instance_id_end) continue;

            // ---- 1. Mark rows, per camera, into ONE store-global flag array.
            // A Uint8Array rather than a Set: a whole-project predicted delete
            // on the real cage5 project marks ~1.3M rows, which as a Set of
            // boxed numbers is tens of MB — the exact allocation class #189/#193
            // spent two PRs removing.
            var kill = new Uint8Array(nInst);
            var storeDeleted = 0;
            var firstKill = nInst;          // rows before it keep their index
            var camsHit = [];               // cameras that lost a row (occupancy)
            for (var ci = 0; ci < camNames.length; ci++) {
                var cn = camNames[ci];
                var rowMap = this.frameRowByCam.get(cn);
                var camDeleted = 0;
                // `opts.only` narrows the walk to the named camera-frames (see
                // the cost note above); without it every row is offered.
                var frameRows = rowMap;
                if (only) {
                    var wanted = only.get(cn);
                    frameRows = [];
                    if (wanted) {
                        for (var wf of wanted.keys()) {
                            var wr = rowMap.get(wf);
                            if (wr !== undefined) frameRows.push([wf, wr]);
                        }
                    }
                }
                for (var [frameIdx, frameRow] of frameRows) {
                    var iStart = Number(fd.instance_id_start[frameRow]) || 0;
                    var iEnd = Number(fd.instance_id_end[frameRow]) || 0;
                    if (iStart < 0) iStart = 0;
                    if (iEnd > nInst) iEnd = nInst;
                    for (var j = iStart; j < iEnd; j++) {
                        // Isolated per row: one malformed row must not abort the
                        // delete for every frame after it, which would leave the
                        // project half-deleted while the GUI showed success.
                        try {
                            if (!kill[j] && shouldDeleteFn(cn, frameIdx, j - iStart, j)) {
                                kill[j] = 1;
                                if (j < firstKill) firstKill = j;
                                deleted++; storeDeleted++; camDeleted++;
                            }
                        } catch (rowErr) {
                            errorRows++;
                            if (!firstError) firstError = rowErr;
                            if (errorRows <= 5) {
                                console.error('[deleteInstanceRows] row ' + j + ' (camera=' + cn +
                                    ', frame=' + frameIdx + ') failed — leaving it in place:', rowErr);
                            }
                        }
                    }
                }
                byCamera[cn] = (byCamera[cn] || 0) + camDeleted;
                if (camDeleted > 0) camsHit.push(cn);
            }
            if (storeDeleted === 0) continue;   // nothing matched in this store

            // ---- 2. Prefix sum: new index of surviving old row i == survBefore[i].
            var survBefore = new Uint32Array(nInst + 1);
            for (var i = 0; i < nInst; i++) survBefore[i + 1] = survBefore[i] + (kill[i] ? 0 : 1);
            var nSurv = survBefore[nInst];

            // ---- 3. Compact EVERY instancesData column of length nInst.
            // Iterating `Object.keys` instead of a hardcoded column list so a
            // future schema addition is carried through rather than silently
            // left at the old length (which would desync the columns).
            // In place, from `firstKill` (see the cost note above): survivors
            // only ever move DOWN, so a forward copy never reads a slot it has
            // already overwritten. A typed column is then re-exposed as a
            // `subarray` view (#193 made these typed arrays; the view keeps
            // the element type — `score` float, `track` int); a plain one is
            // truncated. When more than half the rows went, `slice` hands back
            // a right-sized copy so a bulk delete still releases its memory.
            // A FEW deleted rows (an interactive delete) leave a few long runs of
            // survivors, and `copyWithin` moves each run as one memmove: 10
            // columns x 2.7M rows in ~5 ms against ~70 ms element by element.
            // MANY deleted rows leave many short runs, where the per-call cost
            // loses to the plain loop — hence the cutoff.
            var runs = null;   // flat [start, end) pairs of surviving rows past firstKill
            if (storeDeleted <= DELETE_RUN_COPY_MAX) {
                runs = [];
                var rs = firstKill;
                while (rs < nInst) {
                    while (rs < nInst && kill[rs]) rs++;
                    var re = rs;
                    while (re < nInst && !kill[re]) re++;
                    if (re > rs) runs.push(rs, re);
                    rs = re;
                }
            }
            var shrink = nSurv * 2 < nInst;
            var compacted = new Map();   // column -> its output: an array under two keys moves ONCE
            var idnKeys = Object.keys(idn);
            for (var ki = 0; ki < idnKeys.length; ki++) {
                var col = idn[idnKeys[ki]];
                if (compacted.has(col)) { idn[idnKeys[ki]] = compacted.get(col); continue; }
                if (!col || typeof col.length !== 'number' || col.length !== nInst) continue;
                var w = firstKill;
                if (runs) {
                    for (var rr = 0; rr < runs.length; rr += 2) {
                        col.copyWithin(w, runs[rr], runs[rr + 1]);
                        w += runs[rr + 1] - runs[rr];
                    }
                } else {
                    for (var s = firstKill; s < nInst; s++) if (!kill[s]) col[w++] = col[s];
                }
                var out;
                if (typeof col.subarray === 'function') {
                    out = shrink ? col.slice(0, nSurv) : col.subarray(0, nSurv);
                } else {
                    col.length = nSurv;
                    out = col;
                }
                // Reassign the PROPERTY on the same `instancesData` object —
                // never replace the object itself. `appendStore` and
                // `_computeSparseOccupancy` both read `store.instancesData.<col>`
                // fresh on each access, so this is picked up; replacing the
                // container would orphan any held reference to it.
                idn[idnKeys[ki]] = out;
                compacted.set(col, out);
            }

            // ---- 4. Remap from_predicted through the same table. Values are
            // still in the OLD numbering (copied verbatim above). A link whose
            // target was deleted degrades to -1, which is precisely what
            // `appendStore`'s `outIdxOf` already does for overlay-skipped rows.
            var fpCol = idn.from_predicted;
            if (fpCol) {
                for (var k = 0; k < nSurv; k++) {
                    var fp = Number(fpCol[k]);
                    if (!Number.isFinite(fp) || fp < 0 || fp >= nInst) { fpCol[k] = -1; continue; }
                    fpCol[k] = kill[fp] ? -1 : survBefore[fp];
                }
            }

            // ---- 5. Re-range EVERY frame row of this store (not just this
            // camera's): on a shared store the rows of all cameras interleave in
            // one instance column, so every range shifts. Rows are kept, ranges
            // are rewritten; a collapsed range (start === end) is a legitimate
            // empty frame.
            for (var r = 0; r < nFrameRows; r++) {
                var os = Number(fd.instance_id_start[r]) || 0;
                var oe = Number(fd.instance_id_end[r]) || 0;
                if (os < 0) os = 0; if (os > nInst) os = nInst;
                if (oe < 0) oe = 0; if (oe > nInst) oe = nInst;
                if (oe < os) oe = os;
                fd.instance_id_start[r] = survBefore[os];
                fd.instance_id_end[r] = survBefore[oe];
            }

            // ---- 6. Rebuild each affected camera's sparse track occupancy from
            // the compacted columns, exactly as remapTracksFromIdentity does —
            // `session.trackOccupancy` is this same Map by reference, so the
            // Tracks Timeline picks it up. Without this it shows presence bars
            // for deleted instances forever. Only the cameras that LOST a row:
            // on a shared store the others' ranges moved, but not their content.
            for (var ci2 = 0; ci2 < camsHit.length; ci2++) {
                var cn2 = camsHit[ci2];
                try {
                    var newOcc = this._computeSparseOccupancy(labels, this.nFrames, this.frameRowByCam.get(cn2));
                    if (newOcc) this.trackOccupancy.set(cn2, newOcc);
                    else this.trackOccupancy.delete(cn2);
                } catch (e) { /* occupancy is optional; ignore */ }
            }
            seenLabels.add(labels);
        }

        // ---- 7. Invalidate every resident cache layer, so a cached or later
        // revisited frame re-materializes from the compacted columns instead of
        // serving a frame that still contains the deleted instances. Same two
        // layers and same clearCache-with-per-row-fallback as
        // remapTracksFromIdentity.
        if (seenLabels.size > 0) {
            this.cache.clear();
            this.cacheOrder = [];
            for (var labels2 of seenLabels) {
                if (labels2._lazyFrameList && typeof labels2._lazyFrameList.clearCache === 'function') {
                    labels2._lazyFrameList.clearCache();
                } else if (typeof labels2.releaseFrame === 'function') {
                    for (var camName2 of this.labelsByCam.keys()) {
                        if (this.labelsByCam.get(camName2) !== labels2) continue;
                        var rowMap2 = this.frameRowByCam.get(camName2);
                        if (!rowMap2) continue;
                        for (var frameRow2 of rowMap2.values()) labels2.releaseFrame(frameRow2);
                    }
                }
            }
        }

        if (errorRows > 0) {
            console.error('[deleteInstanceRows] ' + errorRows + ' row(s) failed and were LEFT IN THE ' +
                'PROJECT — the delete is incomplete and the caller must report it rather than claim ' +
                'success. First error:', firstError);
        }
        if (deleted > 0) this._storeEditedInMemory = true;
        return { deleted: deleted, errorRows: errorRows, firstError: firstError, byCamera: byCamera };
    }

    close() {
        // Dropping the labels refs lets each camera's lazy Labels (and its
        // `frameCacheLimit`-bounded internal cache) be GC'd — no manual clear.
        this.labelsByCam.clear();
        this.frameRowByCam.clear();
        this.numNodesByCam.clear();
        this._trackSourceByCam.clear();
        this._skeletonByCam.clear();
        this._nodeOrderByCam.clear();
        this.nodeOrderMismatches = new Map();
        this._storeEditedInMemory = false;
        this.cache.clear();
        this.cacheOrder = [];
        this.videos.clear();
        this.videoIdByCam = null;
    }
}
