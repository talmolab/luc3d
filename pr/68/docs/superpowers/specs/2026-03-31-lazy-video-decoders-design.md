# Lazy Video Decoder Initialization

## Problem
Loading 19+ sessions via multi-session load creates ~114 `OnDemandVideoDecoder` instances simultaneously (19 sessions × 6 cameras). Each decoder creates an HTML5 `<video>` element with `preload: "auto"`, causing Chrome to OOM and crash.

## Solution
**Lazy decoder initialization** — only the active session's video decoders are alive at any time.

### During Multi-Session Load
- **First session:** Full decoder initialization (as before)
- **Other sessions:** Lightweight metadata probe via temporary `<video preload="metadata">` element that is immediately cleaned up. Stores file reference for later lazy init.

### On Session Switch
1. Close old session's decoders (`decoder.close()` releases video elements and blob URLs)
2. Initialize new session's decoders from stored file references
3. Rebuild views and video controller

### Memory Impact
- Before: ~114 video elements buffering simultaneously → Chrome OOM
- After: ~6 video elements (one session) active at any time

## Files Changed
- `index.html`: Added `probeVideoMetadata()`, `initSessionDecoders()`, `closeSessionDecoders()`. Modified `handleLoadSessionFolderPerCamera()` (accepts `deferVideos` option), `handleLoadMultiSession()`, `switchSession()` (now async), `removeSession()`, and V3/SLP load paths.

## Video File Entry Shape
```js
{
    file, name, decoder,        // decoder is null when deferred
    videoWidth, videoHeight,
    frameCount,                 // estimated from metadata when deferred
    assignedCamera,
    sessionIdx,
    _sourceFile: File,          // kept for lazy decoder init
    _deferred: boolean,         // true = decoder not yet initialized
}
```
