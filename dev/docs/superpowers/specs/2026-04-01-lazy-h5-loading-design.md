# Lazy H5 Loading for Large Analysis Files

**Date:** 2026-04-01
**Status:** Approved
**Problem:** Analysis H5 files with 180K+ frames (5 cameras x 56 MB each) cause Chrome OOM crashes during initial load because the entire tracks dataset is eagerly decompressed and converted to JS objects.

## Context

- Dataset: 5 cameras, 180,055 frames, 2 tracks, 15 nodes per track
- Each `.analysis.h5`: ~56 MB on disk (gzip-9), ~86 MB uncompressed (float64)
- Current code reads entire `tracks` dataset via `tracksDs.value`, creates JS objects for every frame/track/node, then structured-clones everything through `postMessage`
- Peak memory: ~1.5-2 GB, exceeding Chrome's per-tab limit
- User workflow: view one frame at a time across all cameras, scrub sequentially or jump to specific frames
- Corrections stored as user labels (sparse), exported to SLP separately — H5 files are read-only

## Approach: Lazy Frame-at-a-Time Loading

Transform the SLP import worker from a "parse and return everything" model to a **persistent data service** that reads H5 frame data on demand via `Dataset.slice()`.

### Threshold

Use lazy loading when `nFrames > 10,000` OR file size > 20 MB. Below that, the existing eager path is unchanged.

## Architecture

```
Main Thread                              Worker (one per camera H5)
─────────────                            ────────────────────────────
LazyFrameLoader                          
  ├── workers: Map<camName, Worker>      
  ├── cache: LRU<frameIdx, camData>      
  ├── prefetchAhead: 20                  
                                         
  open(camName, file) ── open ────────>  Mount via WORKERFS
                      <── metadata ─────  {skeleton, trackNames, nFrames, ...}
                                         Read only: node_names, track_names,
                                         edge_inds, nFrames (< 1ms)
                                         
  getFrame(idx)       ── getFrame(N) ──> Dataset.slice([:,:,:,N])
                      <── frameData ────  Float64Array (transferable)
                                         + per-instance metadata
                                         
  prefetch(idx, dir)  ── getFrames ────> Batch slice, cached in worker
                      <── framesData ───  Multiple frames
                                         
  close()             ── close ────────> Unmount, terminate
```

## Worker Protocol

### Main -> Worker Messages

| type | fields | description |
|------|--------|-------------|
| `open` | `{file: File}` | Mount H5, read metadata, keep file open |
| `getFrame` | `{frameIdx, requestId}` | Read single frame slice |
| `getFrames` | `{startIdx, endIdx, requestId}` | Batch read for prefetch |
| `close` | — | Unmount file, terminate worker |

### Worker -> Main Messages

| type | fields | description |
|------|--------|-------------|
| `metadata` | `{skeleton, trackNames, nodeNames, nFrames, edgeInds, pointScoresAvailable, instanceScoresAvailable}` | After open completes |
| `frameData` | `{frameIdx, requestId, points: Float64Array, trackIndices: Uint8Array, nTracks, nNodes}` | Single frame response |
| `framesData` | `{startIdx, endIdx, requestId, frames: [{frameIdx, points, trackIndices, nTracks, nNodes}]}` | Batch response |
| `error` | `{message, requestId}` | On failure |
| `progress` | `{message}` | During open |

### Data Format

Frame data is sent as flat transferable `Float64Array` to avoid structured clone overhead:
- `points`: flat array of `[x, y, x, y, ...]` for all tracks x nodes. Length = `nTracks * nNodes * 2`.
- `trackIndices`: `Uint8Array` of track index per instance
- Main thread reshapes to `[[x,y], [x,y], ...]` per instance on receipt

## LazyFrameLoader (Main Thread)

```javascript
class LazyFrameLoader {
    constructor() {
        this.workers = new Map();      // cameraName -> Worker
        this.metadata = new Map();     // cameraName -> {trackNames, nFrames, ...}
        this.cache = new Map();        // frameIdx -> Map<cameraName, instanceData>
        this.cacheOrder = [];          // LRU eviction order
        this.maxCacheSize = 100;       // frames
        this.prefetchAhead = 20;
        this.nFrames = 0;
        this.skeleton = null;
    }

    open(cameraName, file) -> Promise<metadata>
    getFrame(frameIdx) -> Promise<Map<cameraName, instances[]>>
    prefetch(frameIdx, direction) -> void  // fire-and-forget
    close() -> void
}
```

### Cache Strategy

- Main thread LRU cache: last 100 frames across all cameras
- Worker-side: caches last 2-3 decompressed H5 chunks (~11K frames per chunk, so most sequential access is a cache hit)
- Prefetch: on navigation, request next 20 frames in scrub direction (fire-and-forget, populates cache)
- Cache key: frameIdx (all cameras for that frame cached together)

## Integration with Existing Code

### Session Changes (pose-data.js)

`Session` gains:
- `lazyLoader`: optional `LazyFrameLoader` instance (set for large H5 files)
- `userEdits`: `Map<frameIdx, FrameGroup>` for user corrections (always in memory, sparse)

### Frame Navigation (index.html)

Current flow:
```javascript
// Direct lookup
var fg = session.frameGroups[frameIdx];
renderFrame(fg);
```

New flow:
```javascript
if (session.lazyLoader) {
    var fg = session.userEdits.get(frameIdx);
    if (!fg) {
        var data = await session.lazyLoader.getFrame(frameIdx);
        fg = createTempFrameGroup(frameIdx, data);
    }
    session.lazyLoader.prefetch(frameIdx, scrubDirection);
} else {
    fg = session.frameGroups[frameIdx];
}
renderFrame(fg);
```

### What Changes

| File | Change |
|------|--------|
| `slp-import-worker.js` | Add `openH5()`, `readFrame()`, `readFrames()` message handlers alongside existing `parseAnalysisH5()` |
| `file-io.js` | Add `LazyFrameLoader` class, `openAnalysisH5()` function |
| `index.html` | Frame navigation uses lazy loader when available; loading flow detects large H5 |
| `pose-data.js` | `Session` gains `lazyLoader` and `userEdits` fields |

### What Stays the Same

- SLP file loading (works for smaller files)
- Small H5 files (< 10K frames) use existing eager path
- All rendering code (overlays.js, viewport3d.js) — receives instances as before
- Video decoding (video.js) — already lazy via OnDemandVideoDecoder
- Export (file-io.js) — iterates user labels only
- Timeline, interaction, triangulation — unchanged

## Performance Expectations

| Metric | Current (eager) | Lazy |
|--------|-----------------|------|
| Startup time | OOM crash | < 500ms (metadata only) |
| Memory (5 cam, 180K frames) | 1.5-2 GB (crash) | ~5-10 MB (cache + metadata) |
| Frame navigation latency | 0ms (in memory) | < 25ms (H5 slice + transfer) |
| Sequential scrub | 0ms | < 5ms (cache hit from prefetch) |
| Playback at 30fps | 0ms | ~33ms budget, 25ms slice = feasible with prefetch |

## Edge Cases

- **User edits a predicted frame**: Create a FrameGroup in `userEdits` with the correction. On next visit, user edit takes priority over lazy-loaded prediction.
- **Frame has no tracks**: Worker returns empty instance list. Main thread shows empty frame.
- **Worker error/crash**: Show error message, allow retry. Don't crash the whole app.
- **Mixed loading**: Some cameras may have SLP (eager), others H5 (lazy). LazyFrameLoader handles only H5 cameras; eager-loaded cameras contribute their frames normally.
