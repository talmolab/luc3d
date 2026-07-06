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
 * NOTE (Phase 4, load+view): `trackOccupancy` is intentionally left empty. The
 * timeline reads it to draw per-track presence bars; for prediction dumps with
 * ~1000s of track fragments a dense occupancy array is both large and a render
 * hazard. Populating it (sparsely) + a virtualized timeline is deferred to the
 * "full pipeline" work.
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
            h5wasmUrl: h5wasmUrl,
            onProgress: onProgress
                ? function (n, total, msg) { onProgress(msg || ('Reading ' + n + '/' + total)); }
                : undefined,
        });
        this.labelsByCam.set(cameraName, labels);

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

        var v = labels.videos && labels.videos[0];
        this.videos.set(cameraName, v ? { filename: v.filename, shape: v.shape } : null);

        return {
            skeleton: this.skeleton,
            trackNames: this.trackNames,
            nFrames: this.nFrames,
            videos: [this.videos.get(cameraName)],
        };
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

    close() {
        // Dropping the labels refs lets each camera's lazy Labels (and its
        // `frameCacheLimit`-bounded internal cache) be GC'd — no manual clear.
        this.labelsByCam.clear();
        this.frameRowByCam.clear();
        this.numNodesByCam.clear();
        this.cache.clear();
        this.cacheOrder = [];
        this.videos.clear();
    }
}
