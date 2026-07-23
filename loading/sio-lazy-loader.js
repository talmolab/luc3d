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
 */

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
        this.trackNames = [];
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
     * Open one camera's `.slp` lazily and record its metadata. First camera's
     * skeleton/tracks win (matches LazyFrameLoader).
     */
    async open(cameraName, file, onProgress) {
        var SIO = window.SleapIO;
        if (!SIO || typeof SIO.readSlpStreaming !== 'function') {
            throw new Error('sleap-io.js readSlpStreaming not available on window.SleapIO');
        }
        // Point the reader's internal I/O worker at LUCID's local vendored h5wasm
        // IIFE (document.baseURI keeps this correct on sub-path deployments).
        var h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
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
        if (!this.skeleton && skel) {
            this.skeleton = {
                name: skel.name || 'skeleton',
                nodes: skel.nodeNames,
                edges: skel.edgeIndices,
            };
            this.trackNames = (labels.tracks || []).map(function (t) { return t.name; });
        }
        this.numNodesByCam.set(cameraName, skel ? skel.nodeNames.length : 0);

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

        // Sparse per-track occupancy for the timeline's presence bars. Best-effort:
        // a cheap columnar pass, never blocking the load.
        try {
            var occ = this._computeSparseOccupancy(labels, maxFrameIdx + 1);
            if (occ) this.trackOccupancy.set(cameraName, occ);
        } catch (e) { /* occupancy is optional; ignore */ }

        var v = labels.videos && labels.videos[0];
        this.videos.set(cameraName, v ? { filename: v.filename, shape: v.shape } : null);

        return {
            skeleton: this.skeleton,
            trackNames: this.trackNames,
            nFrames: this.nFrames,
            videos: [this.videos.get(cameraName)],
        };
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
        var h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
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
     * @returns {Object|null} `{ sparse, nTracks, nFrames, segments, counts }` or null.
     */
    _computeSparseOccupancy(labels, nFrames) {
        var store = labels && labels._lazyDataStore;
        if (!store || !store.framesData) return null;
        var fd = store.framesData;
        var idn = store.instancesData || {};
        var frameIdxCol = fd.frame_idx || fd.frame_id || [];
        var startCol = fd.instance_id_start || [];
        var endCol = fd.instance_id_end || [];
        var trackCol = idn.track || [];
        var nRows = frameIdxCol.length;
        var nTracks = (labels.tracks || []).length;

        var segments = new Map();   // trackIdx -> [{start,end}]
        var counts = new Map();     // trackIdx -> occupied-frame count
        var open = new Map();       // trackIdx -> {start,last}: the run in progress

        for (var r = 0; r < nRows; r++) {
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
     * @param {(camName: string, frameIdx: number, trackIdx: number) => void} visitFn
     *   `trackIdx` is -1 for a trackless instance.
     */
    forEachInstanceRow(visitFn) {
        for (var camName of this.labelsByCam.keys()) {
            var labels = this.labelsByCam.get(camName);
            var store = labels && labels._lazyDataStore;
            var rowMap = this.frameRowByCam.get(camName);
            if (!store || !rowMap) continue;
            var fd = store.framesData || {};
            var idn = store.instancesData || {};
            for (var [frameIdx, frameRow] of rowMap) {
                var iStart = Number(fd.instance_id_start ? fd.instance_id_start[frameRow] : 0) || 0;
                var iEnd = Number(fd.instance_id_end ? fd.instance_id_end[frameRow] : 0) || 0;
                for (var j = iStart; j < iEnd; j++) {
                    var trk = idn.track ? Number(idn.track[j]) : -1;
                    if (!Number.isFinite(trk)) trk = -1;
                    visitFn(camName, frameIdx, trk);
                }
            }
        }
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
     * @param {(camName: string, frameIdx: number, oldTrackIdx: number) => number} remapFn
     *   Returns the new track index (into `newTrackNames`), or a negative
     *   number for "no track."
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
                        var newTrk = remapFn(camName, frameIdx, oldTrk);
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
                var newOcc = this._computeSparseOccupancy(labels, this.nFrames);
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
        if (errorRows > 0) {
            console.error('[remapTracksFromIdentity] ' + errorRows + ' row(s) failed and were left with their ' +
                'OLD (now likely out-of-range) track index — those rows will show as trackless once ' +
                'session.tracks is replaced with the shorter identity-derived list. First error:', firstError);
        }
        return { changed: changed, errorRows: errorRows, firstError: firstError };
    }

    close() {
        // Dropping the labels refs lets each camera's lazy Labels (and its
        // `frameCacheLimit`-bounded internal cache) be GC'd — no manual clear.
        this.labelsByCam.clear();
        this.frameRowByCam.clear();
        this.numNodesByCam.clear();
        this.cache.clear();
        this.cacheOrder = [];
        this.videos.clear();
        this.videoIdByCam = null;
    }
}
