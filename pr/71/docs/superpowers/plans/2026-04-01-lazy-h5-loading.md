# Lazy H5 Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable loading large analysis H5 files (180K+ frames) without Chrome OOM crashes by reading frame data on demand instead of eagerly loading everything into memory.

**Architecture:** Transform `slp-import-worker.js` into a persistent "H5 data service" that stays alive after initial metadata read. A new `LazyFrameLoader` class in `file-io.js` manages worker lifecycle and an LRU frame cache. The main thread requests frame data on demand via the loader, which delegates to the worker's `Dataset.slice()`. Frame navigation in `index.html` is updated to await lazy-loaded data when a `lazyLoader` is present on the session.

**Tech Stack:** h5wasm 0.8.8 (Dataset.slice for chunked reads), Web Workers, vanilla JS

---

## File Structure

| File | Role | Change Type |
|------|------|-------------|
| `slp-import-worker.js` | H5 data service: metadata-only open + on-demand frame reads | Modify |
| `file-io.js` | `LazyFrameLoader` class + `openAnalysisH5Lazy()` | Modify |
| `index.html` | Frame navigation integration, lazy loading flow | Modify |
| `pose-data.js` | `Session.lazyLoader` field | Modify |
| `tests/test-lazy-loader.html` | Browser tests for LazyFrameLoader | Create |

---

### Task 1: Add Lazy H5 Message Handlers to Worker

**Files:**
- Modify: `slp-import-worker.js:40-52` (handleMessage/onmessage)
- Modify: `slp-import-worker.js:437-681` (add new function alongside parseAnalysisH5)

The worker currently handles only `{type: 'parse'}`. We add three new message types for the persistent data service mode: `open`, `getFrame`, `getFrames`, and `close`.

- [ ] **Step 1: Add worker state variables for persistent H5 file**

At the top of `slp-import-worker.js`, after line 19 (`var pendingMessages = [];`), add state for the persistent file handle:

```javascript
// --- Lazy H5 data service state ---
var lazyFile = null;       // h5wasm.File handle (kept open)
var lazyTracksDs = null;   // tracks dataset reference
var lazyTracksShape = null; // [n_tracks, 2, n_nodes, n_frames] or similar
var lazyNTracks = 0;
var lazyNNodes = 0;
var lazyNFrames = 0;
var lazyTransposed = false;
var lazyTrackOccupancy = null; // optional, full array (small: nFrames * nTracks bytes)
```

- [ ] **Step 2: Extend handleMessage to route new message types**

Replace the `handleMessage` function (lines 40-44) with:

```javascript
async function handleMessage(data) {
    if (data.type === 'parse' && data.file) {
        await parseSlp(data.file);
    } else if (data.type === 'open' && data.file) {
        openH5Lazy(data.file);
    } else if (data.type === 'getFrame') {
        readFrameLazy(data.frameIdx, data.requestId);
    } else if (data.type === 'getFrames') {
        readFramesLazy(data.startIdx, data.endIdx, data.requestId);
    } else if (data.type === 'close') {
        closeLazy();
    }
}
```

- [ ] **Step 3: Implement `openH5Lazy()` — metadata-only open**

Add this function after the existing `parseAnalysisH5` function (after line 681):

```javascript
function openH5Lazy(file) {
    try {
        progress('Mounting file (' + (file.size / 1048576).toFixed(1) + ' MB)...');

        try { FS.mkdir('/work'); } catch (e) { /* exists */ }
        try { FS.unmount('/work'); } catch (e) { /* not mounted */ }
        FS.mount(FS.filesystems.WORKERFS, { files: [file] }, '/work');

        var h5path = '/work/' + file.name;
        lazyFile = new h5wasm.File(h5path, 'r');

        progress('Reading metadata...');

        // Read node names
        var nodeNamesDs = lazyFile.get('node_names');
        var nodeNames = [];
        if (nodeNamesDs) {
            var nnVal = nodeNamesDs.value;
            for (var i = 0; i < nnVal.length; i++) {
                nodeNames.push(String(nnVal[i]));
            }
        }
        lazyNNodes = nodeNames.length;

        // Read track names
        var trackNamesDs = lazyFile.get('track_names');
        var trackNames = [];
        if (trackNamesDs) {
            var tnVal = trackNamesDs.value;
            for (var ti = 0; ti < tnVal.length; ti++) {
                trackNames.push(String(tnVal[ti]));
            }
        }

        // Read edges
        var edges = [];
        try {
            var edgeIndsDs = lazyFile.get('edge_inds');
            if (edgeIndsDs) {
                var eiVal = edgeIndsDs.value;
                var eiShape = edgeIndsDs.shape;
                if (eiShape.length === 2) {
                    if (eiShape[0] === 2 && eiShape[1] !== 2) {
                        var nEdges = eiShape[1];
                        for (var ei = 0; ei < nEdges; ei++) {
                            edges.push([Number(eiVal[ei]), Number(eiVal[nEdges + ei])]);
                        }
                    } else {
                        var nEdges2 = eiShape[0];
                        for (var ei2 = 0; ei2 < nEdges2; ei2++) {
                            edges.push([Number(eiVal[ei2 * 2]), Number(eiVal[ei2 * 2 + 1])]);
                        }
                    }
                }
            }
        } catch (e) {
            progress('Warning: could not read edge_inds: ' + e.message);
        }

        // Read tracks dataset metadata (NOT the data itself)
        lazyTracksDs = lazyFile.get('tracks');
        if (!lazyTracksDs) {
            throw new Error('No tracks dataset found in analysis H5');
        }
        lazyTracksShape = lazyTracksDs.shape;

        // Determine orientation
        if (lazyTracksShape.length === 4) {
            if (lazyTracksShape[1] === 2 && lazyTracksShape[2] === lazyNNodes) {
                lazyTransposed = true;
                lazyNTracks = lazyTracksShape[0];
                lazyNFrames = lazyTracksShape[3];
            } else if (lazyTracksShape[2] === 2 && lazyTracksShape[1] === lazyNNodes) {
                lazyTransposed = false;
                lazyNTracks = lazyTracksShape[3];
                lazyNFrames = lazyTracksShape[0];
            } else {
                lazyTransposed = true;
                lazyNTracks = lazyTracksShape[0];
                lazyNFrames = lazyTracksShape[3];
            }
        } else {
            throw new Error('Unexpected tracks dimensionality: ' + lazyTracksShape.length);
        }

        // Backfill track names if empty
        if (trackNames.length === 0) {
            for (var tni = 0; tni < lazyNTracks; tni++) {
                trackNames.push(lazyNTracks === 1 ? 'track' : 'track_' + tni);
            }
        }

        // Read track occupancy (small: nFrames * nTracks uint8 = ~360KB for 180K frames, 2 tracks)
        try {
            var toDs = lazyFile.get('track_occupancy');
            if (toDs) {
                lazyTrackOccupancy = toDs.value;
            }
        } catch (e) { }

        // Build video entry from filename
        var vidName = file.name;
        vidName = vidName.replace(/\.analysis\.h5$/i, '').replace(/\.h5$/i, '');
        var predIdx = vidName.indexOf('.predictions.');
        var sourceVideo = null;
        if (predIdx >= 0) {
            sourceVideo = vidName.substring(predIdx + '.predictions.'.length);
        }
        var videos = [{
            index: 0,
            filename: sourceVideo || vidName,
            sourceFilename: sourceVideo ? vidName : null,
            backendType: 'AnalysisH5',
            shape: null,
            embedded: false,
            dataset: null,
        }];

        progress('Lazy H5 ready: ' + lazyNFrames + ' frames, ' + lazyNTracks + ' tracks, ' + lazyNNodes + ' nodes');

        postMessage({
            type: 'metadata',
            data: {
                skeleton: { name: 'skeleton', nodes: nodeNames, edges: edges },
                trackNames: trackNames,
                nodeNames: nodeNames,
                nFrames: lazyNFrames,
                nTracks: lazyNTracks,
                nNodes: lazyNNodes,
                videos: videos,
            }
        });

    } catch (err) {
        closeLazy();
        var errMsg = (err.message || String(err));
        if (err.stack) errMsg += '\n' + err.stack.split('\n').slice(0, 5).join('\n');
        postMessage({ type: 'error', message: errMsg });
    }
}
```

- [ ] **Step 4: Implement `readFrameLazy()` — single frame slice read**

Add after `openH5Lazy`:

```javascript
function readFrameLazy(frameIdx, requestId) {
    try {
        if (!lazyTracksDs) {
            postMessage({ type: 'error', message: 'No H5 file open', requestId: requestId });
            return;
        }

        // Build instances for this frame
        var instances = [];
        for (var tr = 0; tr < lazyNTracks; tr++) {
            // Check occupancy
            if (lazyTrackOccupancy) {
                var occIdx = frameIdx * lazyNTracks + tr;
                if (occIdx < lazyTrackOccupancy.length && !lazyTrackOccupancy[occIdx]) {
                    continue;
                }
            }

            // Slice one frame of data for this track
            var sliceData;
            if (lazyTransposed) {
                // Shape [n_tracks, 2, n_nodes, n_frames] → slice [tr:tr+1, :, :, frameIdx:frameIdx+1]
                sliceData = lazyTracksDs.slice([[tr, tr + 1], [0, 2], [0, lazyNNodes], [frameIdx, frameIdx + 1]]);
            } else {
                // Shape [n_frames, n_nodes, 2, n_tracks] → slice [frameIdx:frameIdx+1, :, :, tr:tr+1]
                sliceData = lazyTracksDs.slice([[frameIdx, frameIdx + 1], [0, lazyNNodes], [0, 2], [tr, tr + 1]]);
            }

            // Extract points
            var points = [];
            var hasAnyPoint = false;
            for (var nd = 0; nd < lazyNNodes; nd++) {
                var x, y;
                if (lazyTransposed) {
                    // sliceData is flat: [2 * nNodes] for one track, one frame
                    x = Number(sliceData[0 * lazyNNodes + nd]);
                    y = Number(sliceData[1 * lazyNNodes + nd]);
                } else {
                    // sliceData is flat: [nNodes * 2] for one frame, one track
                    x = Number(sliceData[nd * 2 + 0]);
                    y = Number(sliceData[nd * 2 + 1]);
                }

                if (!isNaN(x) && !isNaN(y)) {
                    points.push([x, y]);
                    hasAnyPoint = true;
                } else {
                    points.push(null);
                }
            }

            if (!hasAnyPoint) continue;

            instances.push({
                trackIdx: tr,
                score: 0,
                type: 'predicted',
                points: points,
            });
        }

        postMessage({
            type: 'frameData',
            frameIdx: frameIdx,
            requestId: requestId,
            instances: instances,
        });

    } catch (err) {
        var errMsg = (err.message || String(err));
        postMessage({ type: 'error', message: errMsg, requestId: requestId });
    }
}
```

- [ ] **Step 5: Implement `readFramesLazy()` — batch read for prefetch**

Add after `readFrameLazy`:

```javascript
function readFramesLazy(startIdx, endIdx, requestId) {
    try {
        if (!lazyTracksDs) {
            postMessage({ type: 'error', message: 'No H5 file open', requestId: requestId });
            return;
        }

        var frames = [];
        for (var fi = startIdx; fi < endIdx && fi < lazyNFrames; fi++) {
            var instances = [];
            for (var tr = 0; tr < lazyNTracks; tr++) {
                if (lazyTrackOccupancy) {
                    var occIdx = fi * lazyNTracks + tr;
                    if (occIdx < lazyTrackOccupancy.length && !lazyTrackOccupancy[occIdx]) {
                        continue;
                    }
                }

                var sliceData;
                if (lazyTransposed) {
                    sliceData = lazyTracksDs.slice([[tr, tr + 1], [0, 2], [0, lazyNNodes], [fi, fi + 1]]);
                } else {
                    sliceData = lazyTracksDs.slice([[fi, fi + 1], [0, lazyNNodes], [0, 2], [tr, tr + 1]]);
                }

                var points = [];
                var hasAnyPoint = false;
                for (var nd = 0; nd < lazyNNodes; nd++) {
                    var x, y;
                    if (lazyTransposed) {
                        x = Number(sliceData[0 * lazyNNodes + nd]);
                        y = Number(sliceData[1 * lazyNNodes + nd]);
                    } else {
                        x = Number(sliceData[nd * 2 + 0]);
                        y = Number(sliceData[nd * 2 + 1]);
                    }
                    if (!isNaN(x) && !isNaN(y)) {
                        points.push([x, y]);
                        hasAnyPoint = true;
                    } else {
                        points.push(null);
                    }
                }

                if (!hasAnyPoint) continue;

                instances.push({
                    trackIdx: tr,
                    score: 0,
                    type: 'predicted',
                    points: points,
                });
            }

            frames.push({
                frameIdx: fi,
                instances: instances,
            });
        }

        postMessage({
            type: 'framesData',
            startIdx: startIdx,
            endIdx: endIdx,
            requestId: requestId,
            frames: frames,
        });

    } catch (err) {
        var errMsg = (err.message || String(err));
        postMessage({ type: 'error', message: errMsg, requestId: requestId });
    }
}
```

- [ ] **Step 6: Implement `closeLazy()` — cleanup**

Add after `readFramesLazy`:

```javascript
function closeLazy() {
    try {
        if (lazyFile) { lazyFile.close(); }
    } catch (e) { }
    try { FS.unmount('/work'); } catch (e) { }
    lazyFile = null;
    lazyTracksDs = null;
    lazyTracksShape = null;
    lazyTrackOccupancy = null;
    lazyNTracks = 0;
    lazyNNodes = 0;
    lazyNFrames = 0;
}
```

- [ ] **Step 7: Commit**

```bash
git add slp-import-worker.js
git commit -m "feat: add lazy H5 data service mode to slp-import-worker

Worker now supports persistent open + on-demand frame reads via
Dataset.slice() in addition to the existing full-parse mode."
```

---

### Task 2: Add LazyFrameLoader to file-io.js

**Files:**
- Modify: `file-io.js` (append new class and function at end of file, before any closing comments)

The `LazyFrameLoader` manages one worker per camera, provides `getFrame(frameIdx)` which returns instances for all cameras, and maintains an LRU cache.

- [ ] **Step 1: Add LazyFrameLoader class**

Append to the end of `file-io.js`:

```javascript
// ============================================
// Lazy H5 Frame Loader
// ============================================

/**
 * Manages persistent H5 data-service workers for on-demand frame loading.
 * One worker per camera H5 file, with an LRU frame cache.
 */
class LazyFrameLoader {
    constructor() {
        /** @type {Map<string, Worker>} cameraName -> Worker */
        this.workers = new Map();
        /** @type {Map<string, Object>} cameraName -> metadata from worker */
        this.metadata = new Map();
        /** @type {Map<number, Map<string, Object[]>>} frameIdx -> Map<cameraName, instances[]> */
        this.cache = new Map();
        /** @type {number[]} LRU order (most recent at end) */
        this.cacheOrder = [];
        this.maxCacheSize = 100;
        this.prefetchAhead = 20;
        this.nFrames = 0;
        this.skeleton = null;
        this.trackNames = [];
        this.videos = new Map(); // cameraName -> video metadata
        this._requestId = 0;
        /** @type {Map<number, {resolve, reject}>} requestId -> Promise callbacks */
        this._pending = new Map();
    }

    /**
     * Open an analysis H5 file for a camera. Sends 'open' to worker, returns metadata.
     * @param {string} cameraName
     * @param {File} file
     * @param {function} [onProgress] - Progress callback
     * @returns {Promise<Object>} metadata {skeleton, trackNames, nFrames, ...}
     */
    open(cameraName, file, onProgress) {
        var self = this;
        return new Promise(function (resolve, reject) {
            var worker = new Worker('slp-import-worker.js?v=' + Date.now());

            worker.onmessage = function (e) {
                var msg = e.data;
                if (msg.type === 'metadata') {
                    self.workers.set(cameraName, worker);
                    self.metadata.set(cameraName, msg.data);

                    // Use first camera's metadata for shared fields
                    if (!self.skeleton) {
                        self.skeleton = msg.data.skeleton;
                        self.trackNames = msg.data.trackNames;
                    }
                    if (msg.data.nFrames > self.nFrames) {
                        self.nFrames = msg.data.nFrames;
                    }
                    self.videos.set(cameraName, msg.data.videos ? msg.data.videos[0] : null);
                    resolve(msg.data);
                } else if (msg.type === 'frameData') {
                    var cb = self._pending.get(msg.requestId);
                    if (cb) {
                        self._pending.delete(msg.requestId);
                        cb.resolve({ frameIdx: msg.frameIdx, instances: msg.instances });
                    }
                } else if (msg.type === 'framesData') {
                    var cb2 = self._pending.get(msg.requestId);
                    if (cb2) {
                        self._pending.delete(msg.requestId);
                        cb2.resolve(msg.frames);
                    }
                } else if (msg.type === 'error') {
                    if (msg.requestId !== undefined) {
                        var cb3 = self._pending.get(msg.requestId);
                        if (cb3) {
                            self._pending.delete(msg.requestId);
                            cb3.reject(new Error(msg.message));
                            return;
                        }
                    }
                    reject(new Error(msg.message));
                } else if (msg.type === 'progress' && onProgress) {
                    onProgress(msg.message);
                }
            };

            worker.onerror = function (e) {
                reject(new Error('Worker error: ' + e.message));
            };

            worker.postMessage({ type: 'open', file: file });
        });
    }

    /**
     * Get frame data for all cameras at a given frame index.
     * Returns cached data if available, otherwise fetches from workers.
     * @param {number} frameIdx
     * @returns {Promise<Map<string, Object[]>>} cameraName -> instances[]
     */
    async getFrame(frameIdx) {
        // Check cache
        if (this.cache.has(frameIdx)) {
            this._touchCache(frameIdx);
            return this.cache.get(frameIdx);
        }

        // Request from all workers in parallel
        var self = this;
        var cameraNames = Array.from(this.workers.keys());
        var promises = cameraNames.map(function (camName) {
            var reqId = ++self._requestId;
            var worker = self.workers.get(camName);
            return new Promise(function (resolve, reject) {
                self._pending.set(reqId, { resolve: resolve, reject: reject });
                worker.postMessage({ type: 'getFrame', frameIdx: frameIdx, requestId: reqId });
            });
        });

        var results = await Promise.all(promises);

        // Build cache entry
        var frameMap = new Map();
        for (var i = 0; i < cameraNames.length; i++) {
            frameMap.set(cameraNames[i], results[i].instances);
        }

        this._putCache(frameIdx, frameMap);
        return frameMap;
    }

    /**
     * Prefetch frames ahead of the current position (fire-and-forget).
     * @param {number} frameIdx - Current frame
     * @param {number} direction - +1 for forward, -1 for backward
     */
    prefetch(frameIdx, direction) {
        var self = this;
        var start = direction > 0 ? frameIdx + 1 : Math.max(0, frameIdx - this.prefetchAhead);
        var end = direction > 0 ? Math.min(this.nFrames, frameIdx + this.prefetchAhead + 1) : frameIdx;

        // Skip frames already cached
        var uncachedStart = -1;
        var uncachedEnd = -1;
        for (var fi = start; fi < end; fi++) {
            if (!this.cache.has(fi)) {
                if (uncachedStart < 0) uncachedStart = fi;
                uncachedEnd = fi + 1;
            }
        }

        if (uncachedStart < 0) return; // All cached

        // Fire-and-forget batch request to each worker
        var cameraNames = Array.from(this.workers.keys());
        for (var ci = 0; ci < cameraNames.length; ci++) {
            var camName = cameraNames[ci];
            var reqId = ++this._requestId;
            var worker = this.workers.get(camName);
            (function (cn, rid) {
                self._pending.set(rid, {
                    resolve: function (frames) {
                        for (var fi2 = 0; fi2 < frames.length; fi2++) {
                            var fData = frames[fi2];
                            if (!self.cache.has(fData.frameIdx)) {
                                var entry = self.cache.get(fData.frameIdx) || new Map();
                                entry.set(cn, fData.instances);
                                self._putCache(fData.frameIdx, entry);
                            } else {
                                self.cache.get(fData.frameIdx).set(cn, fData.instances);
                            }
                        }
                    },
                    reject: function () { /* ignore prefetch errors */ }
                });
                worker.postMessage({ type: 'getFrames', startIdx: uncachedStart, endIdx: uncachedEnd, requestId: rid });
            })(camName, reqId);
        }
    }

    /** @private */
    _touchCache(frameIdx) {
        var idx = this.cacheOrder.indexOf(frameIdx);
        if (idx >= 0) this.cacheOrder.splice(idx, 1);
        this.cacheOrder.push(frameIdx);
    }

    /** @private */
    _putCache(frameIdx, data) {
        if (this.cache.has(frameIdx)) {
            this._touchCache(frameIdx);
            return;
        }
        this.cache.set(frameIdx, data);
        this.cacheOrder.push(frameIdx);

        // Evict oldest entries if over limit
        while (this.cacheOrder.length > this.maxCacheSize) {
            var evict = this.cacheOrder.shift();
            this.cache.delete(evict);
        }
    }

    /**
     * Close all workers and free resources.
     */
    close() {
        for (var [, worker] of this.workers) {
            try {
                worker.postMessage({ type: 'close' });
                worker.terminate();
            } catch (e) { }
        }
        this.workers.clear();
        this.metadata.clear();
        this.cache.clear();
        this.cacheOrder = [];
        this._pending.clear();
    }
}
```

- [ ] **Step 2: Add `openAnalysisH5Lazy()` convenience function**

Append after the `LazyFrameLoader` class:

```javascript
/**
 * Open an analysis H5 file lazily (metadata only, frames on demand).
 * @param {string} cameraName
 * @param {File} file
 * @param {LazyFrameLoader} loader - Existing loader to add camera to
 * @param {function} [onProgress]
 * @returns {Promise<Object>} metadata
 */
function openAnalysisH5Lazy(cameraName, file, loader, onProgress) {
    return loader.open(cameraName, file, onProgress);
}
```

- [ ] **Step 3: Commit**

```bash
git add file-io.js
git commit -m "feat: add LazyFrameLoader for on-demand H5 frame reads

LRU-cached frame loader that manages persistent workers per camera,
fetching frame data via Dataset.slice() instead of loading all frames."
```

---

### Task 3: Add Session.lazyLoader Field

**Files:**
- Modify: `pose-data.js:551-569` (Session constructor)

- [ ] **Step 1: Add lazyLoader and userEdits fields to Session constructor**

In `pose-data.js`, in the `Session` constructor (around line 568, after `this.frameIdentityMap = new Map();`), add:

```javascript
        /** @type {LazyFrameLoader|null} Set when using lazy H5 loading */
        this.lazyLoader = null;
```

- [ ] **Step 2: Commit**

```bash
git add pose-data.js
git commit -m "feat: add lazyLoader field to Session for lazy H5 support"
```

---

### Task 4: Integrate Lazy Loading into Session Folder Loading

**Files:**
- Modify: `index.html` (~lines 10948-11030, the session-folder SLP/H5 parse section)

This is the most critical task — we need to detect large analysis H5 files and use lazy loading instead of the eager `parseSlpH5()` path.

- [ ] **Step 1: Add helper function to detect analysis H5 files**

In `index.html`, add a utility function near the other helpers (around line 2015, before `getInstanceGroupsForFrame`):

```javascript
        /**
         * Check if a file is an analysis H5 that should use lazy loading.
         * Returns true for .analysis.h5 or .h5 files over 20MB.
         */
        function shouldUseLazyH5(file) {
            var name = file.name.toLowerCase();
            var isH5 = name.endsWith('.h5') || name.endsWith('.hdf5');
            return isH5 && file.size > 20 * 1024 * 1024;
        }
```

- [ ] **Step 2: Modify session-folder loading to use lazy path for large H5 files**

In the session-folder loading section (~line 10948), find the block that launches all SLP/H5 parses in parallel. We need to split H5 files that qualify for lazy loading from those that don't.

Find this code block (around lines 10948-10972):

```javascript
                // Launch all SLP/H5 parses in parallel (each gets its own web worker)
                showLoading('Parsing annotations (' + matchedCameraDirs.length + ' cameras)...');
                var parseJobs = [];
                for (var cdi = 0; cdi < matchedCameraDirs.length; cdi++) {
                    var camDir = matchedCameraDirs[cdi];
                    if (camDir.slps.length > 0) {
                        var bestVersion = -1;
                        for (var sli = 0; sli < camDir.slps.length; sli++) {
                            var slStem = camDir.slps[sli].name.replace(/\.[^.]+$/, '');
                            var slVer = slStem.match(/_(?:3D_)?v(\d+)$/);
                            var ver = slVer ? parseInt(slVer[1]) : 0;
                            if (ver > bestVersion) bestVersion = ver;
                        }
                        slpVersionsLoaded[camDir.camName] = bestVersion;
                        for (var sli2 = 0; sli2 < camDir.slps.length; sli2++) {
                            parseJobs.push({
                                camName: camDir.camName,
                                file: camDir.slps[sli2],
                                promise: parseSlpH5(camDir.slps[sli2]).catch(function (e) { return null; }),
                            });
                        }
                    }
                }
```

Replace with:

```javascript
                // Launch all SLP/H5 parses — use lazy loading for large H5 files
                showLoading('Parsing annotations (' + matchedCameraDirs.length + ' cameras)...');
                var parseJobs = [];
                var lazyLoader = null; // Created on first lazy H5 file
                var lazyJobs = [];     // {camName, file} for lazy H5 files
                for (var cdi = 0; cdi < matchedCameraDirs.length; cdi++) {
                    var camDir = matchedCameraDirs[cdi];
                    if (camDir.slps.length > 0) {
                        var bestVersion = -1;
                        for (var sli = 0; sli < camDir.slps.length; sli++) {
                            var slStem = camDir.slps[sli].name.replace(/\.[^.]+$/, '');
                            var slVer = slStem.match(/_(?:3D_)?v(\d+)$/);
                            var ver = slVer ? parseInt(slVer[1]) : 0;
                            if (ver > bestVersion) bestVersion = ver;
                        }
                        slpVersionsLoaded[camDir.camName] = bestVersion;
                        for (var sli2 = 0; sli2 < camDir.slps.length; sli2++) {
                            var slpFile2 = camDir.slps[sli2];
                            if (shouldUseLazyH5(slpFile2)) {
                                if (!lazyLoader) lazyLoader = new LazyFrameLoader();
                                lazyJobs.push({ camName: camDir.camName, file: slpFile2 });
                            } else {
                                parseJobs.push({
                                    camName: camDir.camName,
                                    file: slpFile2,
                                    promise: parseSlpH5(slpFile2).catch(function (e) { return null; }),
                                });
                            }
                        }
                    }
                }

                // Open lazy H5 files (metadata only — fast)
                if (lazyJobs.length > 0) {
                    showLoading('Opening ' + lazyJobs.length + ' large H5 files (lazy mode)...');
                    var lazyPromises = lazyJobs.map(function (job) {
                        return lazyLoader.open(job.camName, job.file, function (msg) {
                            showLoading(job.camName + ': ' + msg);
                        }).catch(function (e) {
                            console.error('[lazy-h5] Failed to open ' + job.camName + ':', e);
                            return null;
                        });
                    });
                    await Promise.all(lazyPromises);
                }
```

- [ ] **Step 3: Create session with lazyLoader when lazy files are present**

After the existing `parseResults` processing block (around line 11030, after the for loop that populates frames), add the lazy loader session setup. Find the line after the parse results loop closes:

```javascript
                }
```

And right after the `for (var pri = 0; ...` loop (which ends around line 11030), add:

```javascript
                // If lazy loader was used, create session from its metadata
                if (lazyLoader && lazyLoader.skeleton) {
                    if (!state.session) {
                        var skeleton = new Skeleton(
                            lazyLoader.skeleton.name,
                            lazyLoader.skeleton.nodes,
                            lazyLoader.skeleton.edges
                        );
                        var tracks = lazyLoader.trackNames.length > 0 ? lazyLoader.trackNames : ['track_0'];
                        var sessionName = folderName || ('Session ' + (state.sessions.length + 1));
                        state.session = new Session(cameras.length > 0 ? cameras : [], skeleton, tracks, sessionName);
                        firstSession = state.session;
                        if (state.sessions.indexOf(state.session) < 0) {
                            state.sessions.push(state.session);
                            state.activeSessionIdx = state.sessions.length - 1;
                        }
                    }
                    // Merge track names from lazy loader
                    for (var lti = 0; lti < lazyLoader.trackNames.length; lti++) {
                        if (state.session.tracks.indexOf(lazyLoader.trackNames[lti]) < 0) {
                            state.session.tracks.push(lazyLoader.trackNames[lti]);
                        }
                    }
                    // Attach lazy loader to session
                    state.session.lazyLoader = lazyLoader;
                    // Set skeleton from lazy loader if not already set
                    if (!skeletonFromSlp && lazyLoader.skeleton) {
                        skeletonFromSlp = lazyLoader.skeleton;
                    }
                    // Set total frames from lazy loader
                    if (lazyLoader.nFrames > state.totalFrames) {
                        state.totalFrames = lazyLoader.nFrames;
                    }
                }
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: integrate lazy H5 loading into session-folder flow

Large analysis H5 files (>20MB) now use LazyFrameLoader instead of
eager parseSlpH5, reading only metadata at startup."
```

---

### Task 5: Update Frame Navigation to Support Lazy Loading

**Files:**
- Modify: `index.html` (~line 2198, `drawAllOverlays` and related functions)
- Modify: `index.html` (~line 1025 area, seekToFrame integration in video.js callback)

The core change: when a session has a `lazyLoader`, frame data must be fetched asynchronously before rendering overlays.

- [ ] **Step 1: Add async frame data fetching helper**

In `index.html`, near `getInstanceGroupsForFrame` (around line 2018), add:

```javascript
        /**
         * Ensure frame data is loaded for lazy sessions.
         * For eager sessions, returns immediately. For lazy sessions,
         * fetches the frame data from workers and populates a temporary FrameGroup.
         * @param {number} frameIdx
         * @returns {Promise<void>}
         */
        async function ensureLazyFrameData(frameIdx) {
            var session = state.session;
            if (!session || !session.lazyLoader) return;

            // Already have frame data (from eager load or previous lazy fetch)?
            if (session.frameGroups.has(frameIdx)) return;

            // Fetch from lazy loader
            var cameraData = await session.lazyLoader.getFrame(frameIdx);

            // Don't overwrite if frame was populated while we were waiting
            if (session.frameGroups.has(frameIdx)) return;

            // Build a temporary FrameGroup from the lazy data
            var fg = new FrameGroup(frameIdx);
            for (var [camName, instances] of cameraData) {
                for (var ii = 0; ii < instances.length; ii++) {
                    var instData = instances[ii];
                    var inst = new Instance(
                        instData.points || [],
                        instData.trackIdx,
                        instData.type || 'predicted',
                        instData.score || 0
                    );
                    fg.addInstance(camName, inst);
                }
            }
            session.addFrameGroup(fg);

            // Move to unlinked pool (same as eager loading does)
            for (var [cn, camInsts] of fg.instances) {
                for (var instItem of camInsts) {
                    fg.addUnlinkedInstance(cn, new UnlinkedInstance(instItem, cn));
                }
                fg.instances.set(cn, []);
            }

            // Trigger prefetch in the scrub direction
            var direction = frameIdx >= (state._lastLazyFrame || 0) ? 1 : -1;
            state._lastLazyFrame = frameIdx;
            session.lazyLoader.prefetch(frameIdx, direction);
        }

        /**
         * Evict old lazy-loaded frames to keep memory bounded.
         * Keeps the most recent N frames and any frames with user edits.
         */
        function evictLazyFrames(currentFrame) {
            var session = state.session;
            if (!session || !session.lazyLoader) return;

            var maxKeep = 200; // Keep more than cache to avoid re-fetching
            var keys = Array.from(session.frameGroups.keys());
            if (keys.length <= maxKeep) return;

            // Sort by distance from current frame
            keys.sort(function (a, b) {
                return Math.abs(a - currentFrame) - Math.abs(b - currentFrame);
            });

            // Evict distant frames that have no user edits
            for (var i = maxKeep; i < keys.length; i++) {
                var fIdx = keys[i];
                var fg = session.frameGroups.get(fIdx);
                if (!fg) continue;

                // Keep frames with user instances or instance groups
                var hasUserData = false;
                for (var [, insts] of fg.instances) {
                    for (var inst of insts) {
                        if (inst.type === 'user') { hasUserData = true; break; }
                    }
                    if (hasUserData) break;
                }
                if (!hasUserData) {
                    var groups = session.instanceGroups.get(fIdx);
                    if (groups) {
                        for (var gi = 0; gi < groups.length; gi++) {
                            for (var [, gInst] of groups[gi].instances) {
                                if (gInst.type === 'user') { hasUserData = true; break; }
                            }
                            if (hasUserData) break;
                        }
                    }
                }

                if (!hasUserData) {
                    session.frameGroups.delete(fIdx);
                    session.instanceGroups.delete(fIdx);
                }
            }
        }
```

- [ ] **Step 2: Update seekToFrame callback to await lazy data**

Find the `drawOverlays` callback setup. In the video controller setup, the `drawOverlays` callback calls `drawAllOverlays(frameIdx)` synchronously. We need to make it async-aware.

Find where the video controller callbacks are set up. Search for `drawOverlays:` in index.html. It's in the `rebuildVideoController` function. Read that section:

The key insight: `seekToFrame` in `video.js` calls `this.callbacks.drawOverlays(frameIndex)` synchronously. We need to ensure lazy data is loaded BEFORE the seek renders.

The cleanest approach is to hook into the seekToFrame flow. Find the `drawOverlays` callback (search for `drawOverlays:` in index.html) and wrap it:

```javascript
                drawOverlays: function (frameIdx) {
                    drawAllOverlays(frameIdx);
                },
```

We need to change the approach: instead of making drawOverlays async (which would require changing video.js), we pre-fetch lazy data before seeking. Add a wrapper around `videoController.seekToFrame`:

In `index.html`, find `setupEmptyVideoController` or where `videoController` is first used. Instead of modifying the deep callback chain, add a single wrapper function:

```javascript
        /**
         * Seek to a frame, loading lazy data first if needed.
         * Drop-in replacement for videoController.seekToFrame when lazy loading.
         */
        async function seekToFrameWithLazy(frameIdx) {
            if (state.session && state.session.lazyLoader) {
                await ensureLazyFrameData(frameIdx);
                evictLazyFrames(frameIdx);
            }
            if (videoController) {
                await videoController.seekToFrame(frameIdx);
            }
        }
```

- [ ] **Step 3: Replace videoController.seekToFrame calls with seekToFrameWithLazy**

There are many `videoController.seekToFrame(...)` calls in index.html. We need to replace them with `seekToFrameWithLazy(...)` so lazy data is loaded first.

The calls to replace (all in index.html):

Replace all occurrences of `videoController.seekToFrame(` with `seekToFrameWithLazy(` **except** inside `video.js` itself (which is a different file and handles internal seeking).

Key locations to update:
- Button handlers (btnFirst, btnPrev, btnNext, btnLast) ~lines 3798-3802
- Keyboard navigation ~lines 3864, 3869, 3877, 3881
- `seekToLabeledFrame` ~line 1127
- Timeline `onFrameChange` callback ~line 2902
- Session initialization seeks ~lines 8752-8753, 9903-9906, 10670, 11966-11967
- Frame counter manual entry ~line 13956
- Session switch seeks ~lines 13582-13583, 13617, 13728-13730

For each, change `videoController.seekToFrame(X)` to `seekToFrameWithLazy(X)`.

**Important:** Some of these calls check `if (videoController)` first. The `seekToFrameWithLazy` function already handles this, so the guard can stay or be removed.

For button handlers, for example, change:
```javascript
document.getElementById('btnPrev').addEventListener('click', function () { if (videoController) videoController.seekToFrame(state.currentFrame - 1); });
```
to:
```javascript
document.getElementById('btnPrev').addEventListener('click', function () { seekToFrameWithLazy(state.currentFrame - 1); });
```

Apply the same pattern to all `videoController.seekToFrame` calls in `index.html`. There are approximately 25 locations to update.

- [ ] **Step 4: Handle lazy loading when no video controller exists**

For cases where there are H5 files but no videos loaded yet, we need `seekToFrameWithLazy` to still work. It already does — if `videoController` is null, it loads lazy data and calls `drawAllOverlays` directly. Update the function:

```javascript
        async function seekToFrameWithLazy(frameIdx) {
            if (frameIdx < 0) frameIdx = 0;
            if (frameIdx >= state.totalFrames && state.totalFrames > 0) frameIdx = state.totalFrames - 1;

            if (state.session && state.session.lazyLoader) {
                await ensureLazyFrameData(frameIdx);
                evictLazyFrames(frameIdx);
            }
            if (videoController) {
                await videoController.seekToFrame(frameIdx);
            } else {
                // No video controller — update state and redraw manually
                state.currentFrame = frameIdx;
                updateSeekbar(frameIdx);
                drawAllOverlays(frameIdx);
            }
        }
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: async frame navigation with lazy H5 data loading

seekToFrameWithLazy() pre-loads frame data from H5 workers before
rendering. Includes LRU eviction of old lazy frames to bound memory."
```

---

### Task 6: Update Cleanup and Session Switching

**Files:**
- Modify: `index.html` (clearAllData function ~line 7980, session switching ~line 13638)

- [ ] **Step 1: Close lazy loader when clearing session data**

In the `clearAllData()` function (around line 7980), add lazy loader cleanup. Find the line `state.session = null;` (line 7992) and add before it:

```javascript
            // Close lazy loader if present
            if (state.session && state.session.lazyLoader) {
                state.session.lazyLoader.close();
            }
```

- [ ] **Step 2: Close lazy loader when removing a session**

Search for the `removeSession` function and add similar cleanup there. Find where `state.sessions.splice(...)` is called and add lazy loader close before the session is removed.

- [ ] **Step 3: Handle lazy loader during session switching**

In the session switch code (around line 13638 where `oldSession.lastFrame = state.currentFrame`), the lazy loader stays attached to its session — no special cleanup needed since each session owns its own loader. But when switching TO a session with a lazy loader, we need to load the frame data:

After the session switch sets `state.session` to the new session, find where it seeks to the target frame. Ensure it uses `seekToFrameWithLazy` instead of `videoController.seekToFrame`. This should already be handled by Task 5's replacements.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "fix: close lazy loader on session clear and removal"
```

---

### Task 7: Handle Single-SLP Folder and Drag-Drop Loading

**Files:**
- Modify: `index.html` (~lines 10463-10467, single-SLP loading; ~lines 12024, drag-drop loading)

The single-SLP folder flow and drag-drop flow also use `parseSlpH5`. We need to add lazy detection there too.

- [ ] **Step 1: Update single-SLP folder loading**

Find the single-SLP loading section (around line 10463-10467):

```javascript
                slpData = await parseSlpH5(slpFile, function (msg) { showLoading(msg); });
```

Replace with:

```javascript
                var slpData;
                if (shouldUseLazyH5(slpFile)) {
                    // Lazy loading — build session from metadata only
                    var lazyLoader = new LazyFrameLoader();
                    // Determine camera name from filename
                    var lazyVidName = slpFile.name.replace(/\.analysis\.h5$/i, '').replace(/\.h5$/i, '');
                    var lazyPredIdx = lazyVidName.indexOf('.predictions.');
                    if (lazyPredIdx >= 0) lazyVidName = lazyVidName.substring(lazyPredIdx + '.predictions.'.length);
                    var lazyCamName = lazyVidName.replace(/\.[^.]+$/, '').split('/').pop().split('\\').pop();

                    await lazyLoader.open(lazyCamName, slpFile, function (msg) { showLoading(msg); });

                    slpData = {
                        skeleton: lazyLoader.skeleton,
                        tracks: lazyLoader.trackNames,
                        frames: [], // No eager frames
                        videos: [lazyLoader.videos.get(lazyCamName)],
                        sessions: [],
                        _lazyLoader: lazyLoader,
                        _lazyCamName: lazyCamName,
                    };
                } else {
                    slpData = await parseSlpH5(slpFile, function (msg) { showLoading(msg); });
                }
```

Then after the session is created and before video loading, add:

```javascript
                // Attach lazy loader to session if present
                if (slpData._lazyLoader) {
                    session.lazyLoader = slpData._lazyLoader;
                    if (slpData._lazyLoader.nFrames > state.totalFrames) {
                        state.totalFrames = slpData._lazyLoader.nFrames;
                    }
                }
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: lazy H5 loading for single-SLP and drag-drop flows"
```

---

### Task 8: Manual Testing with Large Dataset

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

```bash
python3 -m http.server 9999
```

- [ ] **Step 2: Test with the large dataset**

Open `http://localhost:9999` in Chrome. Load the dataset at `/root/vast/eric/luc3d_debug/20250928182358_test/` via folder upload. Verify:

1. App does NOT crash during loading
2. Progress messages show "lazy mode" for each camera
3. Frame navigation works (prev/next buttons, keyboard arrows)
4. Overlay rendering shows pose skeletons
5. Scrubbing through the seekbar loads frames on demand
6. Memory usage stays reasonable (check Chrome DevTools → Memory)

- [ ] **Step 3: Test with a small dataset**

Load a small SLP or H5 file to verify the eager path still works correctly.

- [ ] **Step 4: Test frame editing**

Navigate to a frame, double-click a predicted instance to convert to user label, verify the edit persists when navigating away and back.

- [ ] **Step 5: Document any issues found**

If issues are found, fix them before proceeding.

- [ ] **Step 6: Final commit (if fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during lazy H5 testing"
```
