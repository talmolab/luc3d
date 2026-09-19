# Video Decoder Pool Design

**Date**: 2026-04-01
**Status**: Approved
**Supersedes**: 2026-03-31-lazy-video-decoders-design.md

## Problem

Chrome's browser process crashes (`EXC_BREAKPOINT` in `ThreadPoolForegroundWorker`) when too many `<video>` elements and blob URLs are created. With 19 sessions x 3 cameras = 57 `OnDemandVideoDecoder` instances, Chrome hits an internal assertion and crashes the entire browser — not just the tab.

Key findings from debugging:
- **FSAPI enumeration is not the cause** — loading 19 sessions with `deferVideos` (no decoders) completes successfully.
- **Video decoders are the cause** — confirmed by disabling decoder creation, which allowed all 19 sessions to load.
- **`close()` does not help** — Chrome leaks internal state for destroyed video elements. Creating and destroying decoders across session switches still crashes after enough cycles.
- **`switchSource()` is the fix** — reusing the same `<video>` element with a new blob URL avoids element creation/destruction entirely.

## Solution

A fixed pool of `OnDemandVideoDecoder` instances (one per camera, typically 3) created once during the first session load. On session switch, pool decoders swap their video source via `switchSource()`. No video elements are ever created or destroyed after initialization.

## Architecture

### DecoderPool

A lightweight manager on `state.decoderPool` that holds the persistent decoder instances.

```
state.decoderPool = {
    decoders: [],           // OnDemandVideoDecoder[] — persistent instances
    maxSize: 0,             // Set after first session determines camera count
}
```

**API**:
- `initPool(files)` — create decoders for initial session via `decoder.init(file)`. Sets pool size.
- `switchAll(files)` — for each file, call `switchSource()` on the corresponding pool decoder. If `files.length > pool.decoders.length`, create additional decoders. If fewer, leave extras idle.

The pool is intentionally minimal — no LRU, no eviction, no tracking. Just a fixed array of decoders that get their source swapped.

### Modified Loading Flow

#### Initial multi-session load (`handleLoadMultiSession`)

```
for each session (si = 0..N):
    enumerate files via FSAPI (enumerateDirectoryHandle)
    handleLoadSessionFolderPerCamera(files, deferVideos: si > 0)

first session (si=0):
    parse calibration + annotations
    create decoders via init() → these become the pool
    create views, set up grid

subsequent sessions (si>0):
    parse calibration + annotations
    store video File refs in state.videoFiles with decoder: null
    do NOT create any decoders or video elements
```

#### Session switch (`switchSession`)

```
save old session state:
    oldSession.lastFrame = state.currentFrame
    oldSession.triangulationResults = ...
    oldSession._viewport3dState = ...
    oldSession._views = null  (decoders stay alive in pool)

load new session:
    for each video file in newSession.videoFileIndices:
        decoder = state.decoderPool.decoders[i]
        await decoder.switchSource(vf.file)
        update vf.decoder, vf.videoWidth, vf.videoHeight, vf.frameCount
        createViewForVideoFile(vf)

    rebuild VideoController
    seek to newSession.lastFrame
    draw overlays
```

### switchSource() Method (already added to video.js)

Reuses the existing `<video>` element — changes `src` to a new blob URL, waits for `canplay`, updates metadata. Key behaviors:
- Revokes old blob URL before setting new one
- Clears frame cache (ImageBitmaps)
- Closes WebCodecs decoder if active
- Resizes offscreen canvas if dimensions changed
- Re-runs mp4box metadata extraction in background
- Does NOT create new `<video>` element or offscreen canvas

### Data Relationships

```
state.decoderPool.decoders[]     — 3 persistent OnDemandVideoDecoder instances
                                    (never destroyed, source swapped on switch)

state.videoFiles[]               — global array, all sessions
    .file                        — File ref (from FSAPI, persists across switches)
    .decoder                     — points to pool decoder when active, null when inactive
    .sessionIdx                  — which session this belongs to

state.sessions[]                 — all sessions, with annotations in memory
    .videoFileIndices[]          — indices into state.videoFiles
    ._views                     — null (rebuilt on each switch since decoders are shared)

state.views[]                    — active session's views only
    .decoder                    — points to pool decoder
```

## Edge Cases

**Variable camera counts**: Most sessions have 3 cameras. If a session has fewer, extra pool decoders sit idle (no harm). If a session has more cameras than the pool size, grow the pool by creating additional decoders — this only happens once and the pool stays at the new size.

**Single session load**: Pool is created normally. No switching needed.

**SLP project load**: Uses the same pool mechanism when loading multi-session SLP files that need video linking.

**Session removal**: Doesn't affect the pool. Pool decoders persist regardless of which sessions exist.

## Files Changed

- **`video.js`**: `switchSource()` method already added. Verify `_initMp4box()` call works correctly on source swap.
- **`index.html`**:
  - Add `state.decoderPool` to state object
  - `handleLoadSessionFolderPerCamera`: add `deferVideos` parameter (skip decoder creation for non-first sessions)
  - `handleLoadMultiSession`: pass `deferVideos: si > 0`
  - `switchSession`: use pool decoders via `switchSource()` instead of create/destroy

## Performance

- **Initial load**: Same as current — first session's 3 videos loaded, rest deferred
- **Session switch**: ~1-2s to swap 3 video sources (blob URL change + canplay wait)
- **Memory**: 3 video elements + 3 offscreen canvases + 3 frame caches (60 frames each) — constant regardless of session count. All annotation data stays in memory.
- **Chrome resource usage**: Exactly 3 `<video>` elements and 3 active blob URLs at all times. No accumulation.
