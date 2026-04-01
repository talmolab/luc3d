# QC Lite Design

**Date**: 2026-04-01
**Status**: Approved
**Branch**: eric/qc

## Problem

Users need to identify labeling errors across 19+ sessions with 120K+ frames each. Manual inspection is infeasible. The previous QC implementation on `eric/qc-control` predates the 3D standardization refactor (InstanceGroup/identityId/Instance3D) and needs to be ported to the current data model.

## Solution

Port `qc.js` from `eric/qc-control`, trim to 6 metric types, update to the current 3D-standardized data model, and integrate a QC panel into the info sidebar.

## Features

### Metrics (6 types)

1. **Reprojection error** — per-keypoint distance between observed 2D point and reprojected 3D→2D point. Histogram with draggable threshold.
2. **Epipolar distance** — geometric consistency between camera pairs via fundamental matrix. Histogram with draggable threshold.
3. **Node swap detection** — left/right confusion within an instance (e.g., left_ear labeled as right_ear). Detected via reprojection error concentration on symmetric keypoint pairs.
4. **Instance swap detection** — identity switches between tracks across frames. Detected via sudden displacement or crossing trajectories.
5. **Temporal jitter** — abnormal frame-to-frame displacement for a keypoint/track.
6. **Limb length consistency** — per-limb length distribution across frames; outliers flagged via z-score.

### Removed from full QC

- Composite QC score (0-100)
- Bodypart-camera error table

### UI

- **QC tab** in the info panel sidebar
- **Run button** with downsample toggle: All frames, or every Nth (10, 50, 100)
- **Two histograms**: reprojection error and epipolar distance, each with draggable orange threshold line
- **Issue list**: grouped by type, worst-first ordering, consecutive frames collapsed into ranges (e.g., "F120-F135 (16 frames)")
- **Filters**: dropdown to filter by issue type (reprojection, epipolar, swap, jitter, limb_outlier, miss)
- **Navigation**: click issue row → seek to frame. Q/Shift+Q hotkeys for next/prev flagged frame.
- **Toolbar**: QC button + prev/next buttons + badge showing flagged count

### Downsample Option

When enabled, both triangulation and QC analysis run on every Nth frame only. Options: All, every 10th, every 50th, every 100th. Epipolar computation has additional internal subsampling (capped at 5K frames) preserved from the original implementation.

## Data Model Integration

The current codebase uses the 3D standardization from `eric/3d-standardization`:

- `session.instanceGroups`: `Map<frameIdx, InstanceGroup[]>` (flat, not nested by track)
- `InstanceGroup`: has `.identityId` (not `.trackIdx`), `.getInstance(camName)`, `.points3d`
- `Instance`: has `.points[]`, `.type` (user/predicted)
- `session.identities[]`: `Identity` objects
- `session.cameras[]`: `Camera` objects with projection matrices
- `triangulationResults`: `Map<frameIdx, [{group, points3d, reprojections, errors, meanError}]>`

The ported `qc.js` must use `identityId` for per-track analysis, iterate `instanceGroups` as a flat Map, and access instances via `group.getInstance(camName)`.

## Architecture

### Files

- **`qc.js`** (new) — Ported from `eric/qc-control`, trimmed. Pure metrics engine. No DOM access. Exports functions via `window.QC`.
  - `computeFundamentalMatrix(P1, P2)` → 3x3 matrix
  - `computeEpipolarDistance(F, x1, x2)` → pixels
  - `computeReprojMetrics(triResult, config)` → {meanError, perKeypoint, outlierKeypoints, severity}
  - `computeEpipolarMetrics(group, cameras, fMatrices, numKeypoints)` → {perKeypoint, meanDistance}
  - `computeLimbLengthStats(groups, skeleton, cameras)` → per-limb mean/std/CV
  - `computeTemporalMetrics(groups, cameras, numKeypoints)` → per-keypoint velocity stats
  - `classifyErrors(reprojMetrics, epiMetrics, temporalInfo, limbInfo, nodeNames)` → issue[]
  - `runFullAnalysis(session, triangulationResults, config)` → qcResults
  - `drawHistogram(canvas, values, threshold, options)` → void
  - `nextFlaggedFrame(flaggedFrames, currentFrame)` → frameIdx
  - `prevFlaggedFrame(flaggedFrames, currentFrame)` → frameIdx
  - Subsampling: `_subsample(arr, n)`, `MAX_HIST_SAMPLES = 10000`, `EPI_SAMPLE_MAX = 5000`
  - Memory cleanup: free intermediate arrays after accumulation

- **`index.html`** (modify) — QC panel HTML, run/navigation logic, histogram drag interaction, issue list rendering
- **`styles.css`** (modify) — QC panel styling

### State

```javascript
state.qcResults = {
    frameIssues: Map<frameIdx, issue[]>,
    flaggedFrames: Set<frameIdx>,
    distributions: { reproj: number[], epipolar: number[] },
    autoThresholds: { reproj: number, epipolar: number, velocity: number, limbZScore: number },
    limbLengthStats: Object,
    sortedIssues: issue[],
};
```

### Issue Object

```javascript
{
    type: 'reprojection' | 'epipolar' | 'miss' | 'jitter' | 'limb_outlier' | 'swap' | 'inversion',
    severity: 'high' | 'medium' | 'low',
    frameIdx: number,
    identityId: number,
    description: string,  // human-readable, includes keypoint names and error values
}
```

### Issue Grouping

Consecutive frames with same type + identityId + severity grouped into runs (allow 1-frame gaps). Sorted worst-first (high severity first, then by frame). Each run picks a representative frame for navigation.

## Data Flow

```
User clicks "Run QC"
  → if downsample selected, compute frame indices (every Nth)
  → triangulate frames that aren't already triangulated
  → QC.runFullAnalysis(session, triangulationResults, config)
    → pre-compute fundamental matrices (once per camera pair)
    → per-frame: compute reproj, epipolar, temporal, limb metrics
    → classify issues per frame
    → accumulate distributions (subsample to 10K for histograms)
    → compute auto-thresholds (P95)
    → free intermediate arrays
  → render histograms with thresholds
  → group and sort issues
  → render issue list
  → show toolbar badge with flagged count
```

## Performance

- **Subsampling**: every Nth frame for triangulation + analysis. Epipolar internally capped at 5K frames.
- **Memory**: distributions subsampled to 10K points. Intermediate per-frame arrays freed after accumulation. Reprojections computed on-demand and freed.
- **Target**: 180K frames × 3 cameras should complete in <30s with downsample=100, <5min with all frames.

## Non-Goals

- Persisting QC results to SLP files
- Per-session QC (runs on active session only)
- Automated fix suggestions
