# Plan: Fix Triangulate All Memory Crash (180k frames)

## Problem

`triangulateAllFrames()` crashes the browser tab on large datasets (180k frames × 5 cameras).
Each of the ~180k groups stores a result object with duplicate `points3d` and `reprojections` arrays
that are already stored on the `group` object itself. Total memory: ~1-1.5 GB, exceeding the tab's limit.

## Root Cause

Each result entry in `state.triangulationResults` stores:
```js
{
    group: group,                      // reference (fine)
    points3d: result.points3d,         // DUPLICATE of group.points3d
    reprojections: result.reprojections, // DUPLICATE of group.reprojections
    errors: result.errors,             // ~800 bytes — needed by QC + UI
    meanError: result.meanError        // 8 bytes — needed by QC + UI
}
```

`points3d` and `reprojections` are set on the `group` at lines 1164-1165, then stored
**again** in the results map at lines 1199-1200. This doubles the memory reference count
and prevents GC from reclaiming the `result` object after extraction.

Per group (20 keypoints × 5 cameras):
- `reprojections`: ~1,800 bytes (largest)
- `points3d`: ~680 bytes
- `errors`: ~800 bytes
- `meanError`: 8 bytes

180k groups × 3,300 bytes = **~600 MB** just in the results map, on top of the same
data already living on the group objects.

## Who reads what from `state.triangulationResults`

| Consumer | `group` | `points3d` | `reprojections` | `errors` | `meanError` |
|----------|---------|------------|-----------------|----------|-------------|
| `updateFrameInfo()` (UI, every frame change) | — | — | — | YES | YES |
| `QC.computeLimbLengthStats()` | trackIdx | YES | — | — | — |
| `QC.computeTemporalMetrics()` | trackIdx | YES | — | — | — |
| `QC.runFullAnalysis()` per-frame loop | trackIdx | — | — | YES | YES |
| `QC.bodypartCameraErrors()` | — | — | — | YES | — |
| Overlay rendering | — | — | reads from `group.reprojections` | — | — |
| 3D viewport | — | — | — | — | — (reads `group.points3d`) |

Key insight: **`reprojections` is never read from the results map** — overlays read it
from `group.reprojections`. And `points3d` is only read by two QC functions that can
read it from `group.points3d` instead.

## Changes

### Step 1: Stop storing duplicates in `triangulateAllFrames` results
**File:** `index.html` — `triangulateAllFrames()` (~line 1197)

Change `frameResults.push(...)` from:
```js
frameResults.push({
    group: group,
    points3d: result.points3d,
    reprojections: result.reprojections,
    errors: result.errors,
    meanError: result.meanError,
});
```
To:
```js
frameResults.push({
    group: group,
    errors: result.errors,
    meanError: result.meanError,
});
```

This cuts ~2,500 bytes/group → saves **~450 MB** for 180k groups.

### Step 2: Same change in `precomputeTriangulation` and `triangulateCurrentFrame`
**File:** `index.html` — `precomputeTriangulation()` (~line 896) and `triangulateCurrentFrame()` (~line 1041)

Same edit: remove `points3d` and `reprojections` from `frameResults.push(...)`.

Also update the debug log line in `triangulateCurrentFrame` that reads `fr.points3d` → `fr.group.points3d`.

### Step 3: Update QC to read `points3d` from the group
**File:** `qc.js` — `computeLimbLengthStats()` (~line 379) and `computeTemporalMetrics()` (~line 449)

Change:
```js
if (!res.points3d) continue;
var lengths = computeLimbLengths(res.points3d, edges);
```
To:
```js
var pts3d = res.points3d || (res.group && res.group.points3d);
if (!pts3d) continue;
var lengths = computeLimbLengths(pts3d, edges);
```

The fallback keeps backward compat with any code that still passes `points3d` directly.
Same pattern for `computeTemporalMetrics`.

### Step 4: Yield with real delay for GC breathing room
**File:** `index.html` — `triangulateAllFrames()` (~line 1217)

Change yield from:
```js
var YIELD_EVERY = 100;
// ...
if (fi > 0 && fi % YIELD_EVERY === 0) {
    showLoading('Triangulating... ' + fi + '/' + frameIndices.length + ' frames');
    await new Promise(function (r) { setTimeout(r, 0); });
}
```
To:
```js
var BATCH_SIZE = 50;
// ...
if (fi > 0 && fi % BATCH_SIZE === 0) {
    showLoading('Triangulating... ' + fi + '/' + frameIndices.length + ' frames (' + totalGroups + ' groups)');
    await new Promise(function (r) { setTimeout(r, 4); });
}
```

Smaller batches (50 vs 100) and a real 4ms delay gives the GC time to reclaim
temporaries between batches.

### Step 5: Use running sum instead of growing array for avg error
**File:** `index.html` — `triangulateAllFrames()`

Change:
```js
var totalErrors = [];
// ...
totalErrors.push(result.meanError);
// ...
var avgError = totalErrors.length > 0
    ? (totalErrors.reduce(...) / totalErrors.length).toFixed(2)
    : 'N/A';
```
To:
```js
var errorSum = 0;
var errorCount = 0;
// ...
errorSum += result.meanError;
errorCount++;
// ...
var avgError = errorCount > 0 ? (errorSum / errorCount).toFixed(2) : 'N/A';
```

Avoids accumulating a 180k-element array just to compute an average.

## What NOT to change

- **Keep "fill missing views"** — it creates Instance objects for cameras without
  annotations so reprojected predictions show on all frames. This is needed.
- **Keep `errors` in the results map** — QC and `updateFrameInfo` both need it.
- **Keep `group` reference** — QC needs `group.trackIdx` to filter by track.
- **Don't touch the `result` object from `triangulateAndReproject()`** — the function
  itself is fine, we just stop holding onto fields we don't need.

## Expected memory savings

| What | Before | After |
|------|--------|-------|
| `reprojections` in results map | ~324 MB | 0 |
| `points3d` in results map | ~122 MB | 0 |
| `totalErrors` array | ~1.4 MB | 16 bytes |
| **Total saved** | | **~450 MB** |

Remaining memory for 180k groups: ~144 MB (`errors` + `meanError` + group refs).
Should comfortably fit in a browser tab.

## Files touched

1. `index.html` — 3 functions, ~10 lines changed
2. `qc.js` — 2 functions, ~4 lines changed
