# Plan: full-pipeline support for large lazy `.slp` sessions

Status: **planning only — not implemented.** The load + view path is implemented
(see `loading/sio-lazy-loader.js`, `shouldUseLazySlp`, and the folder-loader
routing). This doc plans the remaining work so a lazy folder session (e.g. 3 ×
108k-frame prediction `.slp`) can be triangulated, proofread, exported, and saved
at scale — not just loaded and scrubbed.

## Why this is separate

Lazy load fixes the *initial* OOM by never materializing more than the visited
frames. But several operations still assume the whole project is resident in
`session.frameGroups`, and at 108k frames × 3 cameras that assumption re-creates
the exact memory blow-up lazy load avoids. These are **pre-existing lazy-session
limitations** (they were latent because analysis-`.h5` lazy sessions are small);
they become load-bearing at prediction scale.

## Work items (ranked)

### 1. Streaming export / save (CRITICAL)
Today `buildSlpLabels` / `buildSlpLabelsMultiSession` (`import-export/file-io.js`),
`serializeSessionFrames` (`import-export/save-load.js`), and `buildSlpExportData`
iterate `session.frameGroups` only. On a lazy session they silently drop every
unvisited frame. The "Download All" (`ui/export-modals.js:~1515`) and per-session
(`~1778`) triggers don't call `loadAllLazyFrames`.

- A naïve fix — call `loadAllLazyFrames` first — re-materializes all 108k frames →
  re-OOMs. **Don't do that.**
- **Approach:** batched streaming export. Walk frames in windows (e.g. 2–5k),
  materialize a window via the lazy loader, append its instances to the sleap-io.js
  `Labels` being built (or write incrementally), then **release the window**
  (evict frameGroups + let the LazyFrameList/loader cache drop). `Labels.materialize()`
  is available but is all-or-nothing; prefer per-window `frameAt`/adapter reuse.
- Since export now builds sleap-io.js `Labels` and writes via `saveSlpToBytes`,
  investigate a **sleap-io.js streaming writer** (mirror of the lazy reader) so the
  full graph never needs to be resident on either side — a possible upstream
  companion to `readSlpStreaming({ lazy })`.
- Guard all four serialize sites: if `session.lazyLoader`, use the streaming path.
- Tests: extend `tests/test-multi-session-export.js` / `test-slp-export-canonical.js`
  with a lazy-session case asserting all frames survive.

### 2. Triangulate-all at scale
`groupByIdentityAndTriangulateAll` (`ui/export-modals.js:~253`) already calls
`loadAllLazyFrames` → re-materializes everything. Rework to triangulate in the same
batched windows (materialize → group → triangulate → store 3D → release 2D), so
peak memory stays bounded. Per-group 3D results (`points3d`) are small and can be
retained; the 2D instance graph should not.

### 3. Timeline for ~1,000s of track fragments
Prediction dumps carry hundreds–thousands of fragment tracks (Camera4: 1,416).
- `trackOccupancy` is currently **not** emitted by `SioLazyLoader` (so the timeline
  shows no predicted track bars and the O(cameras×tracks×frames) `_buildTrackSegments`
  loop — ~459M iterations — never runs). To restore track bars without that cost:
  compute **sparse run-segments** in `SioLazyLoader.open` from the columnar
  `instancesData.track` + frame map (one O(nInstances) pass, no dense array), store as
  `{ segments: { trackIdx: [{start,end}] }, nTracks, nFrames }`, and teach
  `ui/timeline.js:_buildTrackSegments` to consume the sparse form (keep the dense
  branch for analysis-`.h5`).
- Independently, cap/virtualize rendered rows (a 1,416-row timeline is unusable);
  the `MAX_CANVAS=32000` clamp (commit 105a689) prevents the crash but not the UX.

### 4. Loose ends
- `Session.numFrames = frameGroups.size` (`pose/pose-data.js:~1200`) shows the
  *visited* count in the info panel; use `state.totalFrames` there for lazy sessions.
- `evictLazyFrames` bounds `session.frameGroups`, but the sleap-io.js `LazyFrameList`
  keeps every frame it ever materialized. For very long scrubbing sessions, add a way
  to drop the LazyFrameList's internal cache (or cap it) to keep peak bounded.
- Cross-camera track alignment: per-camera `.slp` have independent track sets, so
  `trackIdx` doesn't align across cameras (only affects color, not correctness). If
  grouping-by-track is ever wanted, add an explicit remap.

## Validation (each item)
Drive against the real `20260317_…cage5` folder in-browser (3 × 215 MB `.slp` + the
real videos on the host): confirm `performance.memory` stays well under 4 GB through
triangulate-all and Download-All, and that a re-imported export round-trips all
108k frames. Add the unit tests noted per item.
