# LUCID Module Reference

In-depth reference for every ES module in the LUCID codebase. Use this to
locate which module owns a given concern before editing.

The codebase is split across four directories plus two root files:

- `pose/` — data model, triangulation/reprojection math, cross-view tracker.
- `ui/` — DOM-side controllers, overlays, panes, modals, viewport.
- `loading/` — video decoders, session-loader workflows, h5wasm workers.
- `import-export/` — file pickers, parsers, project save/load, SLP import.
- root — `app.js` entry point, `demo-data.js` synthetic dataset.

External script-tag globals (`three`, `mp4box`, `h5wasm`, `dockview-core` —
**pinned to 6.6.1**, see CLAUDE.md Dependencies — and `Mp4Muxer` — local copy in
`lib/mp4-muxer/`, used for 3D-video `.mp4` muxing) are not listed under
"Imports from project modules".

---

## pose/

### pose/initialization.js

**Purpose.** App startup logic. Builds the empty-session UI, wires the
`InteractionManager`, sets up the 3D viewport and timeline, and exposes
helpers used by every load path. Calls `init()` at module-load — replaces
the old `app.js` entry point.

**Key exports.**
- `hideWelcomeOverlay()` — hides the dock empty-state overlay.
- `loadDemoSession()` — File menu "Load Demo Session" handler. Loads
  `sample_session/*.mp4` and synthetic data from `demo-data.js`.
- `addNewInstanceSmart()` — adds a new user instance to the focused view.
  Pose source priority: cached `lastUserPoints` → user instance on the current
  frame → user instance on the nearest **prior** frame (so ctrl+i inherits a
  labeled pose without first nudging a node) → nearest predicted instance →
  default BFS spread layout at the cursor.
- `setupInteraction()` — instantiates `InteractionManager` with all callback
  wiring (selection, drag, double-click, edit-group, etc.).
- `setup3DViewport()` — instantiates `Viewport3D` and wires the
  "Show Camera View"/"Show Initial View" buttons.
- `update3DViewport(frameIdx)` — pushes current InstanceGroups into the 3D
  scene; auto-initializes the viewport if calibration is present.
- `navigateToFrame(frameIdx)` — unified frame navigation used by every UI entry
  point (timeline scrub/drag, transport buttons, arrow/Home/End keys). With a
  video controller it defers to `videoController.seekToFrame`; for a video-less
  project (skeleton + imported 3D points) it clamps to `[0, totalFrames-1]`,
  updates `state.currentFrame`, and re-renders overlays + seekbar + 3D viewport
  directly so the full points3d duration is navigable without a decoder.
- `setupTimeline()` — instantiates `Timeline` and wires its frame-change /
  range-select callbacks plus the display-mode button group. The frame-change /
  drag-end callbacks fall back to `navigateToFrame` when there's no video.
- `updateFpsDisplay()` — refreshes the FPS readout.

**Imports from project modules.**
- `../ui/app-state.js` — `state`, controller singletons + setters, `VIEW_NAMES`.
- `./pose-data.js` — `Instance`, `UnlinkedInstance`.
- `./triangulation.js` — `getInstanceGroupsForFrame`, `updateTimelineForFrame`,
  `reTriangulateGroup`, `sessionHasCalibration`.
- `../loading/video.js` — `OnDemandVideoDecoder`, `VideoController`.
- `../loading/session-loader.js` — `rebuildVideoController`.
- `../import-export/save-load.js` — `markDirty`, `setStatus`, `showLoading`,
  `hideLoading`.
- `../demo-data.js` — `createDemoSession`.
- `../ui/ui-wiring.js` — `setupUI`, `setupMenus`, `updateSeekbar`,
  `onPlaybackStateChange`, `fitTimelineToData`.
- `../ui/info-panel.js` — `setupPanelTabs`, `setupSkeletonEditing`,
  `updateInfoPanel`.
- `../ui/layout-controls.js` — `setupSplitHandles`.
- `../ui/rendering.js` — `drawAllOverlays`, `setReprojErrorVisible`.
- `../ui/sessions-panes.js` — `populateViewStrip`, `populateSessionStrip`.
- `../ui/identity-assignment.js` — `manualAssignState`, `getTotalUnlinkedCount`,
  `cleanupManualAssignment`, `startManualAssignment`, `editGroupState`,
  `cancelEditGroup`, `finishEditGroup`, `updateEditGroupToast`,
  `purgeTriangulationDataForGroup`.
- `../ui/overlays.js` — `getTrackColor`, `getGroupColor`.
- `../ui/viewport3d.js` — `Viewport3D`.
- `../ui/timeline.js` — `Timeline`.
- `../ui/interaction.js` — `InteractionManager`.

**Imported by.** `app.js`, `pose/triangulation.js`, `ui/identity-assignment.js`,
`ui/export-modals.js`, `ui/sessions-panes.js`, `ui/ui-wiring.js`,
`loading/session-loader.js`, `import-export/save-load.js`,
`import-export/slp-import.js`.

**User-facing features.** App boot, demo session loader, smart Add-Instance
(`A` shortcut), 3D viewport auto-init, FPS display, all interaction
callbacks (selection status bar, drag/move feedback, double-click clone,
edit-group remove/add).

---

### pose/pose-data.js

**Purpose.** Pure data-model classes — no DOM, no I/O. The single source of
truth for skeletons, cameras, instances, frame groups, identities, and the
session graph that holds them.

**Key exports.**
- `Skeleton` — node names + edge list. Methods: `addNode`, `removeNode`,
  `addEdge`, `removeEdge`, `clone()` (deep copy with fresh nodes/edges arrays;
  used to cache/seed a remembered skeleton without aliasing a live session),
  `compatibilityKey()` (order-independent canonical string of node names + edges
  as unordered name pairs; two skeletons share a key iff an instance copied from
  one can be pasted onto the other — see instance copy/paste in `ui-wiring.js`),
  static `defaultMouse()`.
- `Camera` — intrinsics (`matrix`), distortion, rvec/tvec, image size.
  Cached getters `rotationMatrix`, `extrinsicMatrix`, `projectionMatrix`;
  methods `project`, `projectPoints` (ideal pinhole, no distortion),
  `undistortPoint` (distorted→ideal, iterative), and `distortPoint`
  (ideal→distorted, OpenCV forward model — the inverse of `undistortPoint`,
  used to re-distort reprojections into native pixel space).
- `Instance` — per-view 2D keypoints with `trackIdx`, `type`
  (`user`/`predicted`/`reprojected`), `score`, `occluded[]`, `nulledNodes`.
  Methods `toggleOccluded`, `setPointVisible`, `backupPoints`, `restorePoints`.
- `UnlinkedInstance` — wrapper around an `Instance` not yet placed in an
  `InstanceGroup`. Auto-incrementing `id`.
- `FrameGroup` — per-frame container of linked `instances` and
  `unlinkedInstances`, both keyed by camera name.
- `Identity` — id + name + color (uses `IDENTITY_COLORS` palette).
- `IDENTITY_COLORS` — 20-color palette for identity badges.
- `InstanceGroup` — cross-view grouped instances + triangulated `points3d`
  + cached `reprojectedInstances`. `markDirty`/`markClean`.
- `Session` — top-level container: cameras, skeleton, tracks, identities,
  frameGroups, instanceGroups. The `numFrames` getter returns
  `lazyLoader.nFrames` on a lazy session (`frameGroups` there holds only the
  visited/resident window, badly understating the project) and `frameGroups.size`
  otherwise. **Tracks and identities are per-session.** The
  constructor copies the incoming `tracks` array (`tracks.slice()`) so two
  sessions never share one — otherwise deleting/adding/renaming a track in one
  session would mutate the others (the multi-session SLP loader used to pass the
  same `slpData.tracks` reference to every session). **Identity is stored ONLY
  per-frame** in
  `frameIdentityMap` ("frameIdx:cam:trackIdx" → identityId; negative = explicit
  "no identity"). There is deliberately no global "cam:trackIdx" default map
  (the removed `trackIdentityMap`) — a global fallback painted stale duplicate
  identities whenever per-frame reality diverged from it. Identity methods:
  per-frame assignment (`setFrameIdentity`, `assignTrackToIdentity` — stamps
  per-frame entries on every frame where that (cam,trackIdx) instance exists;
  `clearTrackIdentity`; `propagateIdentity`), group assignment
  (`assignIdentityToGroup`), lookup (`getIdentityIdForTrack`/
  `getIdentityForTrack` — per-frame only, return null with no fallback;
  `isExplicitNoIdentity`; `isNoIdTrack(trackIdx)` — true for the dedicated
  `NO_ID_TRACK_NAME` ("No ID") track, treated as the null track so overlays
  and the Track panel color it `NULL_ID_COLOR`), `getOrCreateIdentityForTrack` (creates/returns the
  "id_N" identity only — no map side effects), identity↔track propagation
  (`propagateTracksToIdentities` for Tracks→IDs — stamps each instance's
  per-frame identity from its track; `propagateIdentitiesToTracks` for
  IDs→Tracks — overwrites each instance's `trackIdx` with its identity and
  rewrites `tracks` to one unique, non-empty name per used identity so the
  exported SLP has clean identity-named tracks, rewriting `frameIdentityMap`
  under the new keys; instances with no identity — whether entry-less OR
  explicitly marked "no identity" (negative sentinel) — become trackless
  (`trackIdx = null`): a null identity propagates to a null track, and no
  dedicated "No ID" track is created). **Whole-project correctness on a lazy
  session:** both propagate directions used to walk only `frameGroups` — a
  lazy session's small resident window — so an unvisited frame's data was
  under-covered, and `propagateIdentitiesToTracks`'s old wholesale
  `frameIdentityMap` replace (built only from that partial walk) silently
  DESTROYED identity data for every frame outside the window (issue: gray-out
  after "Propagate IDs → Tracks" on a large project). Fixed:
  `propagateIdentitiesToTracks` now derives its used-identity set and the
  remapped `frameIdentityMap` from the existing, always-complete
  `frameIdentityMap` itself (no `frameGroups` walk needed for that part), so
  replacing it wholesale is safe again; `frameGroups` is still walked to keep
  resident instances' `trackIdx` live for immediate GUI feedback. Both
  directions additionally delegate to `session.lazyLoader` when present —
  `propagateIdentitiesToTracks` calls `lazyLoader.remapTracksFromIdentity`
  (rewrites the persistent columnar track column so native SLP export and any
  future re-materialization pick up the change too, with zero frame
  materialization) and `propagateTracksToIdentities` calls
  `lazyLoader.forEachInstanceRow` (read-only project-wide sweep to stamp
  identity for instances outside the resident window) — see
  `loading/sio-lazy-loader.js`. Both are duck-typed (`typeof … === 'function'`)
  so a non-lazy session or the worker-backed `LazyFrameLoader` (which lacks
  these methods) is unaffected. **Perf/correctness follow-up (large lazy
  projects):** `propagateIdentitiesToTracks` now also builds
  `oldKeyToNewTrackIdx` (a "frame:cam:oldTrackIdx" → newTrackIdx map) for free
  while it already walks `frameIdentityMap` in step 2, so its
  `remapTracksFromIdentity` callback is one direct `Map.get` per instance row
  instead of re-deriving the same fact via `getIdentityIdForTrack` +
  `idToTrackIdx.get` (two hash lookups) on every row.
  `propagateTracksToIdentities`'s lazy sweep now memoizes
  `getOrCreateIdentityForTrack` per distinct `trackIdx` (a local
  `identityForTrack` Map) — that lookup is a LINEAR SCAN over
  `session.identities`, and the sweep calls it once per **instance row**
  (millions on a large project); with many distinct tracks the unmemoized
  version is O(rows × identities). `propagateTracksToIdentities`'s final
  "align `group.identityId` with instances' track" pass also used to call
  `assignIdentityToGroup(group, id)` with no frame hint while ALREADY
  iterating every frame of `session.instanceGroups` (project-wide on a lazy
  session, not just the resident `frameGroups` window) — and
  `assignIdentityToGroup` itself re-derives its host frame by scanning ALL of
  `instanceGroups` per call (to find per-frame identity collisions), so doing
  that once per group inside a project-wide loop was an O(frames²) blowup on
  top of the O(rows × identities) one above. Fixed by giving
  `assignIdentityToGroup` an optional 3rd `hostFrameIdx` param: the propagate
  loop now passes the frame index it's already iterating (making its call
  O(1) instead of O(frames)); every other, single-group interactive caller
  (`ui/identity-assignment.js`, `ui/info-panel.js`, `ui/ui-wiring.js`) omits
  it and keeps the original O(project) search, which is fine as a one-off
  per user click. Together these were observed to freeze the tab outright on
  "Propagate Tracks → IDs" for a large heavily-tracked/grouped project — not
  just slow. **`propagateIdentitiesToTracks` also now remaps
  `session.instanceGroups` project-wide (new step 3b)**, not just the
  resident `frameGroups` window: on a lazy session, `instanceGroups` is
  populated for the WHOLE project at reopen with its own lightweight
  per-camera `Instance` members (`reconstructInstanceGroupsFromSessionLazy`,
  `import-export/slp-import.js`) — separate objects from `frameGroups` until
  a frame is scrubbed to, and `finalizeLazyFrameGroup`
  (`pose/triangulation.js`) never refreshes `trackIdx` on that hydration.
  Leaving those members' `trackIdx` stale after `session.tracks` is replaced
  with a new (usually shorter) list broke three things at once: the 3D
  viewport (colors via `group.instances.get(cam).trackIdx`, `ui/overlays.js`
  `getGroupColor`) kept showing old colors, the Instance Info panel's track
  `<select>` went blank (no option matches an out-of-range value), and the
  Timeline showed old track bars overlaid with new ones (`_buildTrackSegments`
  scans `instanceGroups` directly, independent of the `trackOccupancy`-derived
  segments that already reflected the new assignment). `ui/ui-wiring.js`'s
  propagate handlers also now call `update3DViewport(state.currentFrame)`
  (previously missing — only `drawAllOverlays`/`updateInfoPanel`/
  `timeline.refreshTracks` ran), matching the "recolor 3D instances instantly"
  pattern already used by the Color-by-Track/Identity toolbar toggles.
  **First-frame Track/Identity Timeline regression (raw-trackIdx collision):**
  `commitTrackedFrame`'s (`pose/tracker.js`) `writtenThisFrame` collision guard
  marks a (frame,cam,rawTrackIdx) key `-1`/ambiguous in `frameIdentityMap` when
  the raw per-camera tracker briefly assigns the SAME trackIdx to two
  different animals on one frame — most common on frame 0, before the tracker
  has history to differentiate them. Correct for its original purpose (stops
  the 2D overlay's per-camera-per-frame color lookup from confidently showing
  the wrong animal's color) — but `propagateIdentitiesToTracks` resolved each
  instance's new track PURELY through that same ambiguous per-camera key, so
  on a collision frame BOTH colliding instances went trackless (`null`)
  instead of falling back to the one signal that stays unambiguous through a
  collision: each instance's own `group.identityId` (set once per group at
  creation, never shared across two colliding groups). That silently emptied
  the Timeline's Track view AND Identity view for that one frame (self-
  correcting on later frames once the raw tracker differentiates them) — the
  reported symptom was literally "frame 1 [index 0] remains unchanged in
  track view... same is happening with IDs now." Fixed with two additions:
  a **new step 2b** that repairs/supplements `newFrameMap` directly from
  `session.instanceGroups` (so `frameIdentityMap`-only consumers like
  `_buildIdentitySegments` see the correct identity too, not just resident
  in-memory instances), and an `instanceToIdentity` per-instance-object
  fallback Map (built from `instanceGroups` before any remap runs) that
  `remapInstance` (steps 3/3b) checks before falling back to the raw
  per-camera `getIdentityIdForTrack` lookup. Regression test:
  `tests/e2e/first-frame-track-identity-collision.mjs` (builds a synthetic
  raw-trackIdx collision on frame 0 only, propagates, and asserts both
  Timeline display modes cover frame 0 identically to frame 1 — confirmed it
  fails pre-fix with `[null, null]` on the colliding camera's frame-0
  instances and passes post-fix).
  Separately, the auto-generated track-name fallback changed from `'id_' +
  ident.id` to the app's normal `'track_' + index` convention (a genuinely
  custom identity name like "Alice" is still preserved verbatim; only a
  placeholder name matching the `getOrCreateIdentityForTrack` pattern
  `id_<n>` is treated as "no real name" and replaced) — otherwise a
  Tracks→IDs→Tracks round trip renamed `track_0`/`track_1` to `id_0`/`id_1`
  instead of restoring the original naming. Legacy migration (`migrateGlobalIdentitiesToPerFrame` —
  converts a pre-per-frame project's global map to per-frame entries on load),
  group editing (`createGroupFromUnlinked` — when no identity is passed it
  derives one from the first member's track, but only if that member HAS a
  track: grouping trackless instances yields a group with NO identity (-1), not
  a fabricated "id_null"; `unlinkGroup`, `removeInstanceGroup`, `assignToGroup`), repair
  (`deduplicateFrameIdentities`, `scrubOrphanInstances`,
  `_promoteIfMixed`), skeleton propagation
  (`propagateNodeAdded`/`propagateNodeRemoved`), camera-rename
  (`renameCameraInAllData`).
- `clonePoints(points)` — deep-clone helper for `[u,v]|null` arrays.
- `mat3x3Multiply`, `mat3x3Multiply3x4` — matrix utilities used by
  `Camera` and `triangulation.js`.

**Imports from project modules.** None.

**Imported by.** `demo-data.js`, `pose/triangulation.js`,
`pose/initialization.js`, `import-export/file-io.js`,
`import-export/save-load.js`, `import-export/slp-import.js`,
`import-export/slp-merge.js`, `loading/session-loader.js`,
`ui/info-panel.js`, `ui/interaction.js`, `ui/identity-assignment.js`,
`ui/export-modals.js`, `ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** Underpins everything: skeleton editing, instance
manipulation, identity assignment, camera projection, multi-track
bookkeeping, session save/load.

---

### pose/tracker-worker.js

**Purpose.** Web Worker scaffold for batch cross-view tracking (currently
dead code — see comment at top of file). No `new Worker(...)` spawn site
exists in the codebase, and the worker references `CrossViewTracker` and
`Detection2D` which are not defined anywhere.

**Message protocol** (only what the worker handles, even though it can't
run in its current state).
- IN: `{type: 'start', data: {frames, cameras, hyperparameters}}`.
- IN: `{type: 'cancel'}`.
- OUT: `{type: 'progress', frame, total}` — every 100 frames.
- OUT: `{type: 'cancelled', frame}`.
- OUT: `{type: 'complete', results: {identityAssignments, numTargets}}`.
- OUT: `{type: 'error', message}`.

**Imports from project modules.** None (originally used `importScripts`
which was removed during the ESM migration).

**Imported by.** Nothing.

**User-facing features.** None — dead code, intended to back a future
"Track All in Worker" mode.

---

### pose/tracker.js

**Purpose.** Cross-view instance matching and identity assignment. Pairwise
epipolar/reprojection scoring, Hungarian assignment, multi-frame
identity propagation.

**Node weights.** Both the app's CrossViewTracker and the bench-only
`matchFrameInstances` honor per-node weights from the Tracking Wizard
(`getNodeWeightArray`, `ui/settings.js`). `runCrossViewTracker` passes the
resolved weight array into the tracker (`hp.nodeWeights`), where each node's
contribution to the 2D + 3D association cost is scaled and weight-0 nodes are
dropped. `matchFrameInstances` applies the same weights to `epipolarScore`,
`reprojectionScore`, the 3D-distance signal in `reorderGroupsByPrevTargets`, and
each `computeInstanceDistance`. `null` weights ⇒ every node weighted 1.

**Tracking thresholds.** `matchFrameInstances` also snapshots the user-editable
tracking thresholds (`_thresholds = getTrackingThresholds()`, `ui/settings.js`,
set in the Tracking Wizard). The `thr(id)` helper reads that snapshot (falling
back to live defaults) so the Tier A scoring knobs and Tier B reprojection gates
are no longer hard-coded: `epipolarScore` divides by `epipolarDecay`,
`reprojectionScore` uses `reprojSigma`, `crossViewScore` blends by
`epipolarWeight`/`reprojWeight`, `matchPairwise` filters auto-mode matches by
`minMatchScore` and adds `prevIdentityBonus`, and `reprojectionGate(nViews)`
returns `reprojGate2`/`reprojGate3`/`reprojGate4`. Defaults reproduce the prior
constants exactly.

**Benchmark-derived levers (LUC3D ↔ `sleap_3d` parity, bench-only).** Two
thresholds on the legacy `matchFrameInstances` matcher port the two productive
levers from the `G_keeptrack_3d6` benchmark champion; both default to a no-op.
(The app no longer uses this matcher — see the CrossViewTracker above — so these
are exercised only by the benchmark harness.)
- *3D continuity weight (`track3dWeight`, default 1).* In
  `reorderGroupsByPrevTargets`, Signal 2 (3D-position distance) contributes
  `track3dWeight * exp(...)` and adds `track3dWeight` to the weighted-average
  denominator. Raising it (≈6 ≈ champion) makes 3D-position continuity dominate
  the temporal cost, suppressing sustained ID swaps — the analog of the
  reference `correspondence_weight_3d`.
- *Detection-pool filter (`filterMinVisibleNodes`/`filterMinInstanceScore`, both
  default 0 = off).* `collectInstances` gates every instance through
  `passesDetectionFilter` before matching: drop instances with fewer than
  `filterMinVisibleNodes` present keypoints (`countVisibleNodes`), and — when a
  per-instance `score` is available — below `filterMinInstanceScore`. This is the
  geometry/confidence half of the detection filter; full parity (mean-node-score,
  OKS dedup, gap recovery) needs per-detection scores plumbed through the H5
  loader and is not yet implemented.

Covered by `tests/test-tracker-luc3d.mjs` (filter + weight on the real
`matchFrameInstances`) and `tests/test-tracker-gui.mjs` (track/identity
assignment + GUI refresh contract); both run under Node via the bench-style
UI-stubbing loaders (`scripts/bench/hooks.mjs`, `tests/tracker-gui-hooks.mjs`).

**Note.** `reorderGroupsByPrevTargets` passes a true `nTargets × nGroups`
rectangular cost matrix to `hungarianAlgorithm` (no pre-padding to square
with a `1000` filler). The solver's internal padding strips padded-row
claims via its `p[j4] <= n` guard, so padded rows can no longer steal
real group columns — a previously silent group-drop that surfaced
downstream as duplicate identity colors. See
`prompts/tracking-fixes/dup_id.md` Fix #2 for the analysis.

**Residual duplicate fixes (`prompts/dup-id-issue.md`).** Three changes
target the residual duplicates that the rectangular fix left behind, all
rooted in `matchPairwise` dropping *visible* instances:
- *Incremental triangulation (Issue #1).* The "add remaining cameras"
  stage iterates (up to `MAX_REFINE_PASSES`), re-triangulating each group
  from ALL attached views every pass so a group that gains a 3rd/4th view
  reprojects accurately into the cameras it still misses, recovering
  instances a fragile 2-view seed had pushed past the gate.
- *Adaptive gate (Issue #2).* `reprojectionGate(nViews)` replaces the
  fixed 100px cutoff — tight (100) for a 2-view seed, looser (140/180) once
  3+ views make the estimate trustworthy.
- *Single-view groups get no identity (Issue #5).* `matchFrameInstances`
  skips identity assignment for any group with `size < 2` (a lone detection
  with no cross-view partner is not geometrically verified). Such instances
  fall through to the Issue #6 guard and receive `EXPLICIT_NONE` instead of a
  phantom identity, fixing a bug where a solo detection (e.g. frame 1759
  `mid`/`midL`) showed an unassigned identity as present in the ID panel.
- *Explicit "no identity" override (Issue #6).* `matchFrameInstances`
  writes a negative sentinel (`EXPLICIT_NONE`) per-frame for every visible
  instance that landed in no group, so `getIdentity*ForTrack` returns null
  instead of falling back to the stale global `trackIdentityMap`. The two
  getters in `pose-data.js` treat a negative per-frame value as "none".
  `Session.isExplicitNoIdentity(cam, trackIdx, frameIdx)` reports that
  sentinel specifically (distinct from "no entry"). Consumers: overlays
  color such instances space gray (`NULL_ID_COLOR`) when coloring by
  identity; the timeline gives them a gray "No ID" row per camera in the
  identity view; and the identity-grouping passes leave them in the unlinked
  (ungrouped) pool since grouping is by identity — both
  `triangulateCurrentFrame` (`triangulation.js`) and
  `groupByIdentityAndTriangulateAll` (`ui/export-modals.js`, the "Triangulate
  All" path).

**Null-node status.** After a run, `trackCurrentFrame` / `trackAll` count the
null (non-triangulated) 3D nodes across the groups the tracker formed
(`countNullNodesInTargets` over each frame's `targets3d`; single-view groups with
no `points3d` are skipped) and show the total in the bottom-left status bar
(`#statusNullNodes`, `setNullNodesStatus`) and the completion message. Because
node weights change which instances get grouped (not which nodes triangulate),
this is the headline metric for comparing weight settings.

**Auto-cap.** When the user leaves the "Number of animals" prompt empty,
`trackAll` / `trackCurrentFrame` resolve `numAnimals` via
`computeMaxInstancesPerView(session)` — the largest instance count seen
in any (camera, frame) pair across the session — instead of leaving it
null. Without the cap, leftover groups that survive reorder (after Fix
#2) each spawn a fresh `addIdentity('id_N')` call and the identity pool
drifts upward (e.g., 4 → 11 on the test fixture).

**Key exports.**
- `matchFrameInstances(frameGroup, cameras, session, opts)` — match all
  instances in one frame across views; returns groups + identity
  assignments.
- `trackCurrentFrame()` — toolbar / Edit menu "Track Frame" handler.
- `findMatchForSelected()` — Edit menu "Find Match" (note: depends on
  undefined `CrossViewTracker` — latent bug, see comment in source).
- `trackAll()` — toolbar "Track All" handler — runs `matchFrameInstances`
  across every frame with temporal continuity signals.

**Imports from project modules.**
- `./triangulation.js` — `computeFundamentalMatrix`, `triangulatePointDLT`,
  `triangulatePoints`, `reprojectPoint`, `reprojectPoints`,
  `computeInstanceDistance`, `hungarianAlgorithm`.
- `../ui/app-state.js` — `state`, `interactionManager`, `timeline`,
  `getActiveSession`.
- `../ui/settings.js` — `getNodeWeightArray`, `getTrackingThresholds`,
  `getTrackingThreshold`, `isCameraTracked` (both `trackAll`/`trackCurrentFrame`
  drop cameras where `isCameraTracked(name)` is false before tracking; abort with
  a warning if fewer than 2 views remain included).
- `../import-export/save-load.js` — `setStatus`, `showLoading`, `hideLoading`.
- `../ui/rendering.js` — `drawAllOverlays`.
- `../ui/info-panel.js` — `updateInfoPanel`.

**Imported by.** `ui/ui-wiring.js`.

**User-facing features.** "Track Frame" / "Track All" buttons, identity
propagation across frames, find-match-for-selected.

**Tracker engine.** `trackCurrentFrame` / `trackAll` drive the
`CrossViewTracker` (`pose/cross-view-tracker.js`) exclusively — it is the app's
only tracker. The drive lives in
`runCrossViewTracker(session, cameras, frameIndices, propagate, maxTargets)` — a
synchronous loop over `frameIndices` (used by single-frame tracking + the
bench/test harnesses, which read its return value). Its per-frame body is factored
into `createTrackerRun`/`stepTrackerFrame`, reused by the async sibling
`runCrossViewTrackerProgress(…, onProgress)`: identical association but it yields
to the event loop ~every 5% of frames (≈20 updates total) and awaits
`onProgress(done, total)`, so **Track All** repaints a "done/total (pct%)" counter
in the loading overlay instead of freezing at 0/N. Updates are deliberately
infrequent — each yield forces a browser repaint, expensive on a large run — so
the counter steps rather than streams, keeping Track All fast. `buildTrackerDetections` wraps each linked/unlinked instance as a `Detection`;
`commitTrackedFrame` persists, per frame, one `InstanceGroup` per live target
(with `identityId` + `points3d`), maps each target's stable trackId to a session
`Identity`, writes `setFrameIdentity`, and promotes unlinked members into the
linked pool. **Raw-trackIdx collision guard** (regression: 2D-viewer identity
color diverges from the info panel/3D viewport, usually only on the first
frame or two, self-correcting after): per-camera prediction files number
tracks independently PER CAMERA, and a camera's own raw tracker is commonly
less differentiated right at the start of a video. If it briefly assigns the
SAME trackIdx to two DIFFERENT physical animals in the same camera on the
same frame, `commitTrackedFrame` used to write both animals' `setFrameIdentity`
calls to the identical `frameIdentityMap` key — the second silently
overwrote the first. `ui/overlays.js`'s 2D color path queries that exact
per-camera-per-frame key (`getIdentityForTrack`), so it would confidently
show the wrong identity's color for whichever animal lost the race, while
`group.identityId` — read by the info panel and the 3D viewport's
any-camera-fallback color lookup (`getGroupColor` called with no
`cameraName`) — stayed correct the whole time, since it's set once per
group, never through this shared map key. `commitTrackedFrame` now tracks
every `camName:trackIdx` key it writes within a single frame
(`writtenThisFrame`); a second, DIFFERENT identity claiming the same key
marks that key explicit "no identity" (-1) instead of letting either side
silently win — the 2D lookup then correctly misses and falls through to
`group.identityId`, matching what the info panel/3D viewport already show.
`commitTrackedFrame` is exported specifically so this guard is directly
unit-testable; covered by `tests/test-tracker-collision-guard.mjs` (Node,
`scripts/bench/hooks.mjs`-stubbed — drives the real function with two
synthetic colliding targets, not a mock of the guard logic itself). Both Track All and Track Frame pass `propagate:false`: the tracker
assigns **identities only** (per-frame identity map + InstanceGroups). It does NOT
rewrite `Instance.trackIdx` — propagation is a deliberate, user-chosen step via
**Tracks ▸ Propagate IDs → Tracks** (`propagateIdentitiesToTracks`) or **Tracks →
IDs**, so a run never silently clobbers the imported track structure. (Color-by-ID
shows results immediately; Color-by-Track / native `.slp` track export reflect
them once the user propagates.) Both filter out views excluded in the Tracking
Wizard (`isCameraTracked`) and abort if fewer than 2 views remain. **Lazy
sessions:** `session.frameIndices` returns only the resident window on a lazy
`.slp` session (#132). For a windowing-capable loader (`SioLazyLoader` —
`loader.isSync && releaseWindow`), Track All now drives `sweepTrackAllFrames`
(memory-bounded, multi-session save follow-up): materialize a window
(`batchLoadLazyFrames`), step the sequential tracker over it
(`stepTrackerFrame` only ever reads the CURRENT frame's `FrameGroup` — all
cross-frame state lives in the tracker run object, not in `session.
frameGroups`), then release the window (mirrors `ui/export-modals.js`'s
`sweepTriangulationFrames`) — cutting the old full-project `loadAllLazyFrames()`
materialization (a ~1+ GB spike on a 108k-frame×3-camera session) out of Track
All entirely. Verified byte-identical output (`frameIdentityMap`, identity
count, `instanceGroups` count) against the old full-materialization path on
real data. A worker-backed lazy loader (small analysis `.h5`, no windowing)
or a non-lazy session still take the old path: `await loadAllLazyFrames()` to
materialize the whole project, then re-read the full frame list — otherwise it
would silently track only the visited frames. Hyperparameters come from the
`corr2dWeight`/`corr3dWeight`/`velocityThreshold`/`distanceThreshold`/`timePenalty`
tracking thresholds (`ui/settings.js`; defaults are the `G_keeptrack_3d6`
champion values). Track Frame/Track All pass the user's animal count as
`maxTargets` so the tracker caps live targets at that number (a LUCID divergence
from the reference — see `pose/cross-view-tracker.js`; `null`/omitted =
uncapped/faithful). Covered by `tests/test-crossview-populate.mjs` (data-structure
population), `tests/test-cross-view-tracker.mjs` (algorithm), and
`tests/test-tracker-collision-guard.mjs` (`commitTrackedFrame`'s raw-trackIdx
collision guard).

**Legacy `matchFrameInstances` (bench-only).** The original per-frame matcher +
4-signal reorder is retained and exported but **no longer used by the app** —
only by the benchmark harness (`scripts/bench/speed_test.mjs`,
`bench_driver.mjs`) and `tests/test-tracker-luc3d.mjs` for head-to-head engine
comparison. Its thresholds (`epipolarDecay`, `reprojSigma`, `reprojWeight`,
`minMatchScore`, `prevIdentityBonus`, `reprojGate*`, `track3dWeight`) are hidden
from the Tracking Wizard.

---

### pose/cross-view-tracker.js

**Purpose.** `CrossViewTracker` — LUCID's cross-view 3D tracker and the app's
only temporal tracker. Adapted from the `CrossViewTracker` written by Liezl Maree
in the talmolab/sleap-3d repo (Python) and reimplemented in JS; a faithful port
of `/root/vast/eric/sleap-3d/sleap_3d/tracker.py`. A cross-view 3D
multi-target tracker: associates per-camera 2D detections to a running list of 3D
`Target`s, one camera-view at a time, via Hungarian assignment on a cost that
sums a 2D reprojection term and a 3D point-to-ray term. No Kalman filter, no
velocity model, no track aging (matches the reference).

**Coordinate conventions (verified vs `sleap_3d/geometry.py`).** Works entirely
in NORMALIZED camera coordinates: detections are undistorted + K⁻¹-applied on
ingest (`normalizePoint` == `cv2.undistortPoints` with no `P`), and the
"projection matrix" is the camera's bare 3×4 extrinsic `[R|t]`
(`camera.extrinsicMatrix`). `distanceThreshold` is in world units (mm);
`velocityThreshold` is in normalized image units (so the 2D term saturates and
the 3D term dominates — hence `corr3dWeight` is the meaningful knob).

**Exports.** `CrossViewTracker` (class: `trackFrame(detsByCam, camsOrder)`,
maintains `.targets`), `Detection` (2D observation: `pointsNorm`/`pointsPixel` +
`cam`/`frameIdx`/`slot`), `normalizePoint`.

**Faithful-port quirks preserved (do NOT "fix").** Per-view-per-frame
association; `velocity`/`distance` thresholds are SOFT (drive the cost negative,
not hard gates) and negative matches are not filtered; the 3D term ignores the
time gap; 3D velocity is zero; re-triangulation is plain DLT over all stored
per-view detections. Adds a defensive `nansum`-style skip of non-finite cost
terms (robust to a degenerate `[I|0]` camera).

**LUCID divergence — `maxTargets` (opt-in target cap).** The reference has NO
animal-count cap; births are unbounded and IDs stay bounded only via upstream
detection filtering. The constructor accepts an optional `hp.maxTargets`: when a
positive integer, `_initializeTargets` stops spawning births once that many live
targets exist (leftover detections are dropped for the frame and re-acquired by
matching next frame). `null`/omitted (the default) restores exact reference
behavior, so bench/comparison runs stay faithful. Wired from Track All / Track
Frame via the user's animal count.

**LUCID divergence — `nodeWeights` (per-node association weights).** The reference
weights every node equally. The constructor accepts an optional `hp.nodeWeights`
array (indexed to `Instance.points`); `_adjacency2d`/`_adjacency3d` scale each
node's cost contribution by its weight via `_nodeWeight(k)` and skip weight-0
nodes entirely (dropping them from matching). `null`/omitted ⇒ every node weighted
1 (faithful). Wired from `runCrossViewTracker` via the Tracking Wizard's Node
Weights section (`getNodeWeightArray`).

**Imports.** `pose/triangulation.js` (all geometry is coordinate-agnostic and
reused by passing the bare extrinsic + normalized points:
`triangulatePoints`, `reprojectPoint`, `backProjectToRays`,
`pointsToRayDistances`, `hungarianAlgorithm`, `computeFundamentalMatrix`,
`epipolarErrorMatrix`).

**Imported by.** `pose/tracker.js`.

---

### pose/triangulation.js

**Purpose.** DLT triangulation, bundle-adjustment refinement, reprojection
math, fundamental-matrix / epipolar utilities, Hungarian assignment. Also
hosts the lazy-H5 frame loader and the user-facing triangulation orchestration
(single-frame, all-frames, multi-frame range).

**Triangulation methods.** `'dlt'` (default) is the fast linear DLT.
`'ba'` initializes from DLT then runs per-point Levenberg–Marquardt bundle
adjustment minimizing geometric reprojection error (slower, more accurate).
Cameras are fixed (calibrated), so each keypoint is refined independently.
The method is selected via `options.method` on `triangulateAndReproject` and
threaded through the orchestration functions; the chosen method is recorded on
each group (`group.triangulationMethod`) and in each `state.triangulationResults`
entry (`.method`) so the info panel can label it. Grouping operations
(`groupByIdentityAndTriangulateAll`, group-by-track) always use DLT.

**Distortion handling.** 2D keypoints on disk are lens-distorted. Triangulation
(DLT and BA) runs in ideal pinhole space: observations are undistorted first
(`Camera.undistortPoint`). Reprojections meant for display or error comparison
must therefore be **re-distorted** back to native pixel space
(`reprojectPointCamera` / `reprojectPointsCamera` → project, then
`Camera.distortPoint`). Comparing ideal reprojections against raw distorted
keypoints previously produced spurious error that grew toward the frame edges
("fisheyed coordinates", issue #85) and could drive cross-view identity
switches. The temporal-identity cost in `ui/identity-assignment.js` likewise
projects 3D targets with distortion before measuring distance to raw detections.

`triangulateAndReproject` reports the reprojection error in **both** spaces:
`meanError`/`errors` (distorted — what is drawn and broken down per view/node)
and `meanErrorUndistorted`/`errorsUndistorted` (ideal pinhole — the space BA
actually minimizes). The info panel shows the distorted value as the headline
("N.NN px", colour-coded) with the undistorted value as a small subtitle below
it ("undist N.NN px"); the per-view and per-node breakdowns remain
distorted-space. Both error spaces are recomputed on project load — `.slp`
projects in `slp-import.js` and JSON/v2/v3 projects in `save-load.js`
(`_restoreProjectV2`) — mirroring this dual computation so the undistorted
subtitle is populated for loaded projects, not just freshly triangulated ones.

**Key exports.**
- BA math: `triangulatePointBA(observations, projMatrices, initial?, options?)`,
  `triangulatePointsBA(allObservations, projMatrices, initialPoints?)`,
  `triangulationMethodLabel(method)` → `'DLT'` | `'Bundle Adjustment'`.
- Math: `triangulatePointDLT`, `triangulatePoints`, `reprojectPoint`,
  `reprojectPoints` (ideal pinhole), `reprojectPointCamera` /
  `reprojectPointsCamera` (project then re-distort into the camera's native
  pixel space — use these whenever reprojections are compared against or drawn
  over raw keypoints), `computeReprojectionError`,
  `computeReprojectionErrors`, `computeMeanReprojectionError`,
  `computeInstanceDistance(pointsA, pointsB, weights?)` (optional per-node
  `weights` → weighted mean distance; weight-0 nodes ignored; omitted ⇒ all 1),
  `hungarianAlgorithm`, `cameraCenter`,
  `invert3x3`, `backProjectToRay`, `backProjectToRays`,
  `pointToRayDistance`, `pointsToRayDistances`,
  `computeFundamentalMatrix`, `epipolarError`, `epipolarErrorMatrix`.
- Group math: `triangulateAndReproject(instanceGroup, cameras, options)`
  (`options.method` = `'dlt'`|`'ba'`, `options.triangulateOnly`; returns
  `.method`, `.meanError`/`.errors` distorted-space and
  `.meanErrorUndistorted`/`.errorsUndistorted` ideal-pinhole-space),
  `storeReprojectedInstances(group, triangulationResult, allCameras)`.
  **Two robustness features:** (1) views excluded in the Tracking Wizard's Camera
  Views panel (`isCameraTracked`, or `options.includedCameras` override) never
  contribute to the 3D solve, but are still reprojected INTO — an excluded view
  shows the reprojected skeleton + its error without influencing geometry. (2)
  Reprojection-error threshold (Tracking Wizard `reprojErrorThreshold` px, opt-in /
  default 0 = off, or `options.reprojErrorThreshold`): does not include a
  **node-in-a-view** (one 2D keypoint) whose reprojection error exceeds the
  threshold, and re-triangulates that node from the remaining views. It acts per
  node within a view — never on a whole view (wizard's job). Excludes the single
  worst over-threshold observation per node per pass and re-triangulates between
  passes (each exclusion shifts the remaining views' errors, so it re-checks); a
  node left with <2 views under the threshold is nulled. Covered by
  `tests/test-triangulation-robust.js`.
- Lazy loading: class `LazyFrameLoader` (analysis `.h5`, worker-backed) +
  `shouldUseLazyH5(file)`; `shouldUseLazySlp(file)` + `LAZY_SLP_THRESHOLD` route
  large prediction `.slp` to the main-thread `SioLazyLoader`
  (`loading/sio-lazy-loader.js`). Shared consumers: `ensureLazyFrameData`,
  `buildLazyFrameGroupSync`, `batchLoadLazyFrames` (branches on `loader.isSync`
  for worker-free loaders), `loadAllLazyFrames`, `evictLazyFrames` (prunes
  `session.frameGroups`, and on its throttled tick also calls
  `SioLazyLoader.capInternalCaches` to bound the loader's internal typed-frame
  caches — which `frameGroups` eviction alone leaks).
  `LazyFrameLoader` spawns `loading/slp-import-worker.js` (resolved against
  `document.baseURI` so sub-path deployments work — see ISSUES.md I-8) for HDF5
  reads.
  **`_rawInstIndex` tagging (#158 fix).** All three lazy-materialization sites
  (`ensureLazyFrameData`, `buildLazyFrameGroupSync`, and the worker-batch
  branch of `batchLoadLazyFrames`) tag every constructed `Instance` with
  `inst._rawInstIndex = ii` — `ii` being that instance's position within its
  frame's raw instance list, which equals its exact row offset in the lazy
  store's `[instance_id_start, instance_id_end)` range for that
  (camera, frame). `import-export/slp-streaming-write.js`'s `refFor` reads
  this directly on save instead of guessing the row via `trackIdx` matching —
  see that module's docs for why the guess was wrong. Verified against Elly's
  real ~108k-frame×3-camera dataset in `scratch/2026-07-13-elly-perf/`: the
  old trackIdx-only heuristic produced 8 real ref collisions (wrong animal's
  2D pose/track attached to a group) in the first 3000 frames alone;
  `_rawInstIndex` resolved all 35611 refs with zero collisions. Regression
  test: `tests/e2e/save-multiinstance-ref-integrity.mjs`
  (`npm run test:ref-integrity`).
- Frame access: `getInstanceGroupsForFrame`,
  `frameHasGroupedUserInstances`, `updateTimelineForFrame`.
- Orchestration: `triangulateMultiFrameInstances(start, end, onProgress, method)`,
  `reTriangulateGroup` (preserves the group's existing method),
  `triangulateCurrentFrame(method)`, `triangulateAllFrames(method)`
  (`method` defaults to `'dlt'`), `sessionHasCalibration`,
  `showCalibrationRequiredPopup`,
  `ensureGroupsFromIdentities(session, frameIdx)` — auto-creates a frame's
  InstanceGroups from its per-frame identity assignments (>=2-camera buckets;
  explicit-none stays unlinked) when none exist yet. Both
  `triangulateCurrentFrame` and `triangulateAllFrames` call it, so each works
  directly after **Track All** (which assigns identities but does not group).
  `triangulateAllFrames` now sweeps every frame (not just pre-grouped ones),
  so Triangulate All populates the 3D viewer after Track All; previously it
  found no groups and bailed.

**Imports from project modules.**
- `./pose-data.js` — `mat3x3Multiply`, `FrameGroup`, `Instance`,
  `UnlinkedInstance`, `InstanceGroup`.
- `../ui/app-state.js` — `state`, `timeline`, `viewport3d`.
- `../ui/rendering.js` — `setReprojErrorVisible`, `drawAllOverlays`.
- `../ui/info-panel.js` — `updateTriangulationBadge`.
- `../import-export/save-load.js` — `markDirty`, `setStatus`,
  `showLoading`, `hideLoading`.
- `./initialization.js` — `update3DViewport` (circular).

**Imported by.** `pose/tracker.js`, `pose/initialization.js`,
`import-export/save-load.js`, `import-export/slp-import.js`,
`loading/session-loader.js`, `ui/rendering.js`, `ui/info-panel.js`,
`ui/identity-assignment.js`, `ui/export-modals.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** "Triangulate" key (`T`), Edit menu Triangulate
Frame / All / Multi-Frame, reprojection-error visualization, lazy SLP
loading, "Triangulation needed" badge.

---

## ui/

### ui/app-state.js

**Purpose.** Central application state and controller-singleton registry.
Exports `state` (mutable shared bag) plus five live-binding controllers
(`videoController`, `interactionManager`, `viewport3d`, `timeline`,
`paneManager`) updated through setter functions. Exposes
`window.__lucid` for DevTools inspection.

**One skeleton per project.** The pose skeleton is project-level: every
`state.sessions[*].skeleton` points at ONE shared object, so it can't diverge
across sessions and the exported `.slp` always carries a single skeleton (no
duplicates for sleap-io/sleap-nn). `setProjectSkeleton(sk)` points all sessions
at `sk` and stores it as the default new sessions inherit; `getProjectSkeleton()`
returns it; `buildRememberedSkeleton()` now returns that SHARED reference (not an
independent clone). The editor mutates the shared object in place so edits
propagate for free; node add/remove additionally fan out via
`propagateNode{Added,Removed}` across each session's instances (see
`ui/info-panel.js` → `applyProjectSkeleton` / warn-on-overwrite modal).
Calibration and `envSkeleton` remain per-session.

**Key exports.**
- `state` — mutable application state (current frame, sessions, dirty
  flag, view list, color mode, etc.).
- `videoController`, `interactionManager`, `viewport3d`, `timeline`,
  `paneManager` — live `let` bindings.
- `setVideoController`, `setInteractionManager`, `setViewport3D`,
  `setTimeline`, `setPaneManager`.
- `hasRealVideo()` — true only when a view actually has a decoder. A non-null
  `videoController` is NOT sufficient: `setupEmptyVideoController()` installs one
  at app init, and a skeleton + imported-3D-points project keeps that empty
  controller. Frame navigation / playback branch on this, not on the
  controller's existence (used by `navigateToFrame`, the transport buttons, and
  the keyboard handler so play/pause + stepping work without video).
- `VIEW_NAMES` — `['back', 'mid', 'side', 'top']`.
- `getActiveSession()`, `setActiveSession(session)`.
- `rememberSkeleton(skeleton)` / `buildRememberedSkeleton()` — in-memory cache of
  the last non-empty skeleton the user built or loaded, so newly loaded
  videos/sessions inherit it instead of starting blank. `rememberSkeleton` stores
  a `clone()` and ignores empty skeletons; `buildRememberedSkeleton` returns a
  fresh clone (or null). Module-level state: carries across video loads within one
  app session, resets on a full page reload (no persistence).
- `setInstanceClipboard(data)` / `getInstanceClipboard()` — in-memory clipboard
  for the instance copy/paste feature (Cmd/Ctrl+C / Cmd/Ctrl+V). Holds a copied
  UserInstance as `{ compatKey, pointsByName: { name -> {point, occluded} },
  sourceView, sourceFrame }`, so paste can remap points by node name onto a
  matching skeleton. Same lifetime model as the remembered skeleton (app session
  only). Filled/read by `copySelectedInstance`/`pasteInstance` in `ui-wiring.js`.

**Imports from project modules.** None.

**Imported by.** `pose/initialization.js`, `pose/triangulation.js`,
`pose/tracker.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `loading/session-loader.js`,
`ui/info-panel.js`, `ui/rendering.js`, `ui/identity-assignment.js`,
`ui/export-modals.js`, `ui/sessions-panes.js`, `ui/layout-controls.js`,
`ui/ui-wiring.js`.

**User-facing features.** Backs literally everything — session switching,
playback state, dirty tracking, multi-session UI.

---

### ui/export-modals.js

**Purpose.** Modal dialogs for bulk-triangulation and export (Group-by-Track,
Group-by-Identity, multi-frame triangulation, SLP per-session, SLP by-camera,
SLP all-sessions, JSON labels, points3d H5, reproj H5).

**Key exports.**
- `showGroupByTrackModal()` — modal that bulk-groups by trackIdx.
- `groupByIdentityAndTriangulateAll()` — bulk-group then triangulate. Ends by
  calling `update3DViewport(state.currentFrame)` so the 3D viewer populates for
  the current frame (this is the path "Triangulate All" takes when identities
  exist; previously it refreshed only the 2D overlays, leaving 3D empty).
- `sweepTriangulationFrames(session, onFrame, opts)` (module-private) +
  `frameGroupHasUserInstances(fg)` — memory-bounded driver both bulk-triangulate
  paths (identity + track) now use. On a windowing-capable lazy session
  (`SioLazyLoader`) it walks `0..nFrames` in windows: materialize a window
  (`batchLoadLazyFrames`) → run `onFrame` per resident frame → **release** the
  window (delete predicted-only `frameGroups` + `loader.releaseWindow`), keeping
  peak at one window instead of the whole ~108k×3 graph. This replaces the old
  `loadAllLazyFrames`-then-iterate path (which re-OOMed) and fixes the silent-drop
  bug where only visited frames were processed. Non-lazy / worker-lazy sessions
  iterate resident `frameGroups` exactly as before. Compact 3D results persist in
  `session.instanceGroups`; user-edited frames are never released.
- `showExportResultPopup(message, ok)` — small centered ✓/✗ confirmation card
  shown after an SLP export (auto-dismisses, faster on success; also closes on
  click/Esc/Enter). Used by the By-Cam and per-session flows: on success they
  close their modal and pop "Download Successful"; on error they pop "Download
  Failed: …".
- `showSlpExportModal()` — single-camera SLP export modal (pick one camera per
  session, export to one file). **Retained but no longer wired to the File menu**
  — its old "Export SLEAP File" item was replaced by "Export SLEAP File Per
  Session" (`showSlpExportPerSessionModal`).
- `showSlpExportPerSessionModal()` — "Export SLEAP File Per Session": bulk export
  for the **open/active session only**. Lists every assigned-camera view in that
  session with a per-row **Download** checkbox (default ON; only checked rows are
  exported), camera, target directory, and versioned output filename
  `<stem>_vN.slp`, with Include options — **Predicted Instances** (checkbox), **Reprojections**
  (checkbox) emitted as UserInstance/PredictedInstance via a toggle; user labels
  always included. On Export it **always prompts** for a folder
  (`window.showDirectoryPicker` — it does not silently reuse a cached
  `state.exportDirHandle`) and writes one 2D `.slp` per camera
  into that camera's associated subdirectory (`state.cameraDirMap[cam] || cam`),
  via `exportSlpClientSide(...)`. Versioned names mean source `.slp` files are
  never overwritten. Falls back to flat `downloadBlob` downloads when the File
  System Access API is unavailable. Esc closes the modal.
- `showSlpExportByCamModal()` — "Export SLEAP File By Cam": camera×session grid.
  Each camera column exports across all its selected sessions into one SLEAP
  file; the modal **bulk-exports every included column at once** via
  **Download All**, which **always prompts** for a destination folder
  (`window.showDirectoryPicker` — it does not silently reuse a cached
  `state.exportDirHandle`) and
  writes each included camera as a flat `<CamName>.slp` into it (falling back to
  per-file `downloadBlob` browser downloads when the File System Access API is
  unavailable). A cell is a green ✓ (toggle on/off) only where the camera VIEW
  exists in that session — derived from `state.videoFiles` (real loaded views),
  plus cameras with labeled data for SLP-only projects; NOT from
  `session.cameras`, which is the full calibration list and would falsely imply
  existence. Sessions missing the view show a red ✗ (not selectable). The table
  **footer holds a per-column include toggle** (`.slp-bycam-incl`, ✓/✗) deciding
  whether that camera is part of Download All; a column whose toggled-on sessions
  have incompatible skeletons is **blocked** — its toggle is disabled (with an
  explanatory `title`) and excluded from the export — checked set-based /
  order-insensitively via `findSkeletonMismatch` and re-evaluated on every cell
  toggle (`updateDownloadStates`). A red warning under the tables
  (`#slpByCamSkelWarning`) flags blocked columns. Include options (stacked) —
  **Save PredictedInstances** (checkbox, default on) and, beneath it, **Save
  Reprojections** (checkbox, emitted as UserInstance/PredictedInstance via a
  toggle) — are passed to `exportSlpMultiSession` as an `instanceFilter`
  (`{user:true, predicted, reprojected}`); user labels are always included. The
  Save Reprojections row is **disabled unless at least one session has
  reprojections** (any `InstanceGroup.reprojectedInstances` populated, i.e.
  triangulation/tracking has run). Download All shows per-file
  progress; **Esc closes the modal**, or cancels an in-progress export mid-run.
  Columns ordered by session frequency, then within-session name order, then
  session recency for session-unique views.
- `showSlpExportAllModal()` — multi-session SLP export. **Deprecated**: no longer
  wired to a File-menu item (the "Export 2D SLP (All Views)" entry was removed);
  retained for reference.
- `showExport3DVideoModal()` — File ▸ "Export 3D Video". Mounts a second
  `Viewport3D` (reusing the panel code) in a modal so the user can orbit/zoom to
  pick the camera angle. Controls: prev (`⏮`) / play-pause (`▶`/`⏸`,
  self-rescheduling timer at the current FPS) / next (`⏭`) preview transport; a
  progress-bar track with two **draggable start/end nodes** (default first/last
  frame) backed by two **editable, validated Start/End fields** (illegal input —
  non-integer, out of `[0, lastFrame]`, or crossing the other bound — is rejected
  and reverted); an editable FPS (duration = selectedFrames / fps); a
  **resolution picker** (360p/720p/1080p/2K) that sets the output dimensions and
  the matching H.264 level (`avc1.42001E` / `42001F` / `420028` / `420032`); live
  readouts for **Duration**, **Exported Frames** (= selected range, updates with
  the Start/End nodes/fields) and **Estimated File Size** (`_v3dBitrate` ×
  duration ÷ 8, formatted by `_fmtBytes`; recomputed on range/FPS/resolution
  change — same bitrate the encoder is configured with); and
  Cancel / Export (all inputs disabled + playback stopped during an export).
  Export renders only the selected `[start, end]` range into the viewport at the
  chosen resolution (`renderer.setPixelRatio(1)` + `setSize(W,H)` + matching
  camera aspect), captures through an even-dimensioned 2D canvas, and encodes an
  `.mp4` via WebCodecs `VideoEncoder` muxed with `mp4-muxer` (global `Mp4Muxer`,
  local copy in `lib/mp4-muxer/`). Timestamps are relative to the range start.
  Requires a Chromium-based browser (WebCodecs) — error status otherwise.
- `showTriangulateMultiFrameModal()` — frame-range triangulation modal.
- `exportLabels()` — JSON labels export.
- `exportPoints3dH5()` — points3d H5 export.
- `exportReprojH5()` — reprojection H5 export.

**Imports from project modules.**
- `./app-state.js` — `state`, `viewport3d`, `timeline`, `getActiveSession`.
- `../pose/pose-data.js` — `InstanceGroup`.
- `../pose/triangulation.js` — `triangulateAndReproject`,
  `storeReprojectedInstances`, `frameHasGroupedUserInstances`,
  `loadAllLazyFrames`, `triangulateMultiFrameInstances`,
  `sessionHasCalibration`, `showCalibrationRequiredPopup`,
  `getInstanceGroupsForFrame`.
- `./viewport3d.js` — `Viewport3D` (Export 3D Video modal).
- `./overlays.js` — `getTrackColor`, `getGroupColor` (Export 3D Video modal).
- `./rendering.js` — `drawAllOverlays`, `setReprojErrorVisible`.
- `./info-panel.js` — `updateInfoPanel`.
- `../import-export/save-load.js` — `showLoading`, `hideLoading`,
  `setStatus`.
- `../import-export/file-io.js` — `exportSlpClientSide`,
  `exportSlpMultiSession`, `findSkeletonMismatch`, `buildPoints3dH5`,
  `buildReprojH5`.
- `../pose/initialization.js` — `update3DViewport`.

**Imported by.** `ui/ui-wiring.js`.

**User-facing features.** File menu Export (JSON / SLEAP File / SLEAP File By
Cam / **3D Video (.mp4)** / H5 points3d / H5 reproj), Edit menu Group-by-Track /
Group-by-Identity, Multi-Frame Triangulate modal.

---

### ui/identity-assignment.js

**Purpose.** All workflows for grouping instances into identities — manual
assignment, edit-group mode, automatic assignment, single-frame
triangulation, multi-frame assignment modal, track/identity helpers.

**Key exports.**
- Track helpers: `swapAssignTrack`, `assignTrackToSelected`,
  `propagateIdentityForward`, `assignIdentityToSelected`,
  `purgeTriangulationDataForGroup`, `swapTracks`.
  `assignIdentityToSelected` (and the info-panel Identity dropdowns) propagate
  the identity from the CURRENT frame **forward only** via the swap-aware
  `propagateIdentity` — they no longer call `assignTrackToIdentity` (which
  re-stamped EVERY frame of the track, corrupting already-correct earlier
  frames when fixing a mid-video swap; issue #155). Whole-track identity
  assignment is still available via **Tracks ▸ Propagate Tracks → IDs**; to
  identity-stamp a whole track from the dropdown, assign at the track's first
  frame.
- Manual assign: `manualAssignState`, `getTotalUnlinkedCount`,
  `cleanupManualAssignment`, `startManualAssignment`.
- Edit group: `editGroupState`, `startEditGroup`, `cancelEditGroup`,
  `finishEditGroup`, `cleanupEditGroup`, `updateEditGroupToast`.
- Auto assign: `autoAssignState`, `cleanupAutoAssignment`,
  `runAutomaticAssignment`, `runTrackedAssignment`.
- Triangulation flows: `runSingleFrameTriangulation`,
  `showMultiFrameModal`, `startViewSelectionForFrames`,
  `showMultiFrameProgressModal`, `runMultiFrameAssignment`.

**Imports from project modules.**
- `./app-state.js` — `state`, `videoController`, `interactionManager`,
  `viewport3d`, `timeline`, `paneManager`.
- `../pose/pose-data.js` — `InstanceGroup`, `UnlinkedInstance`.
- `../pose/triangulation.js` — `frameHasGroupedUserInstances`,
  `getInstanceGroupsForFrame`, `triangulateAndReproject`,
  `storeReprojectedInstances`, `reprojectPoints`,
  `computeInstanceDistance`, `hungarianAlgorithm`,
  `updateTimelineForFrame`, `triangulateCurrentFrame`.
- `./rendering.js` — `drawAllOverlays`, `setReprojErrorVisible`.
- `./info-panel.js` — `updateInfoPanel`.
- `../import-export/save-load.js` — `markDirty`, `setStatus`.
- `../pose/initialization.js` — `update3DViewport`.
- `./sessions-panes.js` — `panelRenderers`.

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`,
`ui/rendering.js`, `ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** Manual identity assignment toast workflow,
Edit Group mode, Auto-Assign / Tracked Assign, single-frame and
multi-frame triangulation modals, track-swap dialogs.

---

### ui/info-panel.js

**Purpose.** Right-hand info panel — populates the Videos, Cameras,
Skeleton, Sessions, and Frame Info tables; hosts the skeleton editor and
the per-frame instance-group / unlinked-instance tables.

**Instance-panel track/identity dropdowns.** Each grouped/unlinked instance
row has a track `<select>` and an identity `<select>`. Both selects include a
`(none)` option (value `-1`) and a `(+) New Track` / `(+) New ID` option (value
`__new__`). The track select defaults to `(none)` for a trackless instance/group
(trackIdx == null) — it does NOT snap to the first track (index 0); selecting
`(none)` sets the instance(s) trackless (the group path also unassigns its
identity). Choosing `(+) New …` replaces the select with an inline text box
(`startInlineNameEntry`) where the user types a name and presses Enter to create
+ assign it (Esc or blur cancels); tracks are deduped by name, identities reuse
an existing same-named identity. This replaces
the removed Tracks-menu "Assign Track" / "Assign Identity" submenus; the reusable
`assignTrackToSelected` / `assignIdentityToSelected` helpers remain exported from
`ui/identity-assignment.js`. These assignment/create handlers (and the
`assign*ToSelected` helpers) refresh the timeline with `{ keepSize: true }` so a
track/identity edit never regrows the bottom timeline panel — it rebuilds +
repaints at the user's current height instead of growing to fit all rows.

**Responsive panel tabs.** `setupPanelTabs` makes the tab bar (Instances,
Visibility, Videos, Cameras, Skeleton, Session) width-aware. Each tab sizes to
its full name (never ellipsis-truncated); a `ResizeObserver` on `.panel-tabs`
runs `layoutPanelTabs()`, which greedily keeps the leading tabs whose names fit
the panel's current width and demotes the rest into an auto-built **"More ▾"**
dropdown (`.panel-tab-more*` in styles.css). Widening the panel promotes tabs
back into the bar one at a time. At least the first tab always stays in the bar.
The dropdown closes on outside-click or `Esc`; the More button shows the active
highlight when the selected tab currently lives inside it.

**Key exports.**
- Tab control: `setupPanelTabs`.
- Tables: `populateVideosTable`, `populateCamerasTable`,
  `populateSkeletonTable`, `populateSessionAssignTable`,
  `populateUnassignedVideos`.
- Detail dialogs: `showVideoFileDetail`, `showCameraDetail`.
- Skeleton editor: `setupSkeletonEditing`, `exportSkeletonJSON` (download wrapper
  around `buildSkeletonJSON`). `parseSkeletonJSON` now lives in
  `import-export/skeleton-json.js`.
- Per-frame data: `updateInfoPanel`, `updateFrameInfo`,
  `updateTriangulationBadge`.
- Session: `ensureSession` (seeds new sessions from `buildRememberedSkeleton`).

**Skeleton persistence.** `populateSkeletonTable` calls `rememberSkeleton` on every
refresh — the central point after any editor mutation (add/remove node or edge,
Load Skeleton) or loaded project — so the current non-empty skeleton is cached for
the app session. `ensureSession` (and the session-loader fresh-session sites) seed
new sessions from `buildRememberedSkeleton`, so an imported/built skeleton carries
over to subsequently loaded videos (no re-import). Cache is in-memory only (resets
on reload); see `ui/app-state.js`.

**Imports from project modules.**
- `../pose/pose-data.js` — `Skeleton`, `Camera`, `Session`.
- `../pose/triangulation.js` — `getInstanceGroupsForFrame`.
- `./overlays.js` — `REPROJECTION_COLOR`.
- `./rendering.js` — `drawAllOverlays`, `updateFrameCounters`.
- `./interaction.js` — `isInteractiveClickTarget`.
- `./app-state.js` — `state`, `timeline`, `interactionManager`,
  `rememberSkeleton`, `buildRememberedSkeleton`.
- `../import-export/save-load.js` — `setStatus`, `markDirty`.
- `../import-export/skeleton-json.js` — `buildSkeletonJSON`, `parseSkeletonJSON`.
- `../loading/session-loader.js` — `handleLoadVideos`,
  `handleLoadCalibration`, `autoAssignVideosToCameras`,
  `createViewForVideoFile`, `rebuildVideoController`,
  `fitCanvasesToCells`, `loadSingleSessionFromCache`.
- `./ui-wiring.js` — `unlinkGroup`, `showGroupContextMenu`.
- `./identity-assignment.js` — `swapAssignTrack`, `propagateIdentityForward`.
- `./sessions-panes.js` — `populateSessionsPanel`, `populateViewStrip`,
  `populateSessionStrip`.

**Imported by.** `pose/initialization.js`, `pose/tracker.js`,
`pose/triangulation.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `loading/session-loader.js`,
`ui/rendering.js`, `ui/identity-assignment.js`, `ui/export-modals.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** All right-panel tabs (Videos, Cameras, Skeleton,
Sessions, Frame Info), skeleton editor (add/remove nodes, edges,
import/export JSON), per-frame instance-group context menus,
triangulation status badge.

**Visibility tab — Timeline subsection (Block 2 / Prompt 4).** Adds a
`populateTimelineVisibility(session)` exported function plus a private
`buildVisToggleRow(entry, onChange, opts)` helper that renders one toggle
row inside `#visTimelineCameras` / `#visTimelineTracks` /
`#visTimelineIdentities`. Each row uses the existing `.toggle-switch`
markup (`<label class="toggle-switch"><input type="checkbox"><span
class="slider"></span></label>`) rather than a bare checkbox so the
control matches the rest of the Visibility panel. Track AND identity
rows both render a `.vis-color-swatch`: identity rows pull from
`identity.color`, track rows compute their swatch via
`getTrackColor(i)` (imported from `./overlays.js`) where `i` is the
row's position in `session.tracks` — the same palette-index the
timeline canvas itself uses for the bar color, so the swatch in the
panel matches the bar the user sees on the timeline. Camera rows have
no swatch (cameras have no intrinsic color in the data model).

The change listener calls `toggle{Camera,Track,Identity}Visibility(session, name)`
followed by `timeline.refreshTracks(session, { keepSize: true })` so
the timeline rebuilds its segment list and repaints without resizing
the outer container or the inner canvas (see `ui/timeline.js`'s
`refreshTracks` size-preserving mode note), then recursively
re-renders the toggle lists to refresh the visible-state attributes.
`populateTimelineVisibility` is called from `updateInfoPanel(...)`
(every in-frame mutation already triggers it) and again from
`switchSession` after `timeline.setData(newSession)` so the lists
reflect the freshly-active session's hidden sets.

**Visibility tab — section order + Display Legend (Phase-7 refinement).**
`index.html` reorders the tab so the **Timeline** subsection is at the
top of the Visibility panel (above User / Predicted / Reprojections).
The **Display Legend** control is its own `<h3>` section sitting between
Reprojections and Video Brightness, mirroring how Video Brightness and
Video Rotation are presented. All static checkboxes in the panel
(`visLegend`, `vis3dLabelShow`, `vis3dSphereShow`, `vis3dPyramidShow`,
`vis3dNodeShow`, `vis3dEdgeShow`) were converted to the `.toggle-switch`
markup so the panel has one consistent control style throughout.


---

### ui/interaction.js

**Purpose.** Mouse and keyboard interaction system — node selection,
dragging, hit testing, instance conversion, manual-assignment selection,
edit-group mode, keyboard shortcuts.

**Key exports.**
- `InteractionManager` — class wired by `pose/initialization.js`. Selected
  methods: `attach(views)`, `detach()`, `select`, `clearSelection`,
  `findNearestNode`, `findNearestUnlinkedNode`, `setAssignmentMode`,
  `setEditGroupMode`, `addToAssignmentSelection`,
  `getAssignmentSelectedIds`, `onMouseDown`/`onMouseMove`/`onMouseUp`/
  `onMouseLeave`, `onKeyDown`, `_addNewInstance` (used by smart-add; lays out a
  new skeleton via an inline BFS fan-out from the highest-degree root, with a
  vertical-line fallback when there are no edges).
- `isInteractiveClickTarget(target)` — used by other UI to skip
  click-through on form controls.

**Zoom-aware thresholds.** `_displayToVideo(state, viewName)` returns how many
video pixels span one CSS pixel on screen given the view's current `zoom.scale`.
Hit-test padding (`findNearestNode`/`findNearestUnlinkedNode`) and the drag-start
deadzone (`_onDragMove`, ~3 CSS px) multiply by it so they stay constant on screen
— previously the deadzone was a fixed 3 video px, which forced a large on-screen
drag at high zoom and blocked fine node adjustments.

**Imports from project modules.**
- `../pose/pose-data.js` — `Instance`.

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`.

**User-facing features.** Click-to-select skeleton nodes, drag to move
keypoints, double-click to convert predicted → user, shift-drag to add
to manual-assignment selection, right-click to null/restore nodes,
keyboard shortcuts (delete, alt-drag clone, etc.).

**Grouping/ungrouping shortcuts.** `onKeyDown` handles only the legacy `c`
confirm-group alias (creates a group from a ready ≥2 assignment selection).
The primary group (`Shift+G`) and ungroup (`Shift+U`) shortcuts are
**catalog-dispatched** and wired in `ui/ui-wiring.js` (`setHandler`); ungroup
delegates to that module's `unlinkGroup` (the complete path: data-model
`Session.unlinkGroup` + triangulation purge + overlay/3D/timeline/info-panel
refresh). The old incomplete `InteractionManager._unlinkSelectedGroup` helper
was **removed** (it had no production callers).

---

### ui/loading-progress-modal.js

**Purpose.** Generic per-task progress panel for long-running load
operations. Designed to be plugged into video decoder loads (per-camera
rows) and future SLP project parsing. Per-row weighted-monotonic bar
(canplay × 0.1 + mp4box × 0.9) prevents reset at the phase boundary;
phase color flips signal transitions (red → blue → green).

**Key exports.**
- `LoadingProgressModal` (class) — flat task API: `addTask`, `updateTask`,
  `completeTask`, `failTask`, `show`, `dismiss`, `reset`, `isOpen`,
  `getTaskState`. Two-level (session-group + child task) API:
  `addSessionGroup({ label })` (alias: `addSession`, `addParentTask`) →
  `groupId`; `addTaskToSession(groupId, { label })` (alias: `addChildTask`);
  `setCurrentSession(groupId)` (alias: `setActiveSession`);
  `completeSession(groupId)` (alias: `finishSession`);
  `failSession(groupId, error)`; `setProjectImportHeader({ current, total })`
  (alias: `setHeader`, `setSessionProgress`). `addTask({ sessionId })`
  attaches a flat-API task as a child of the named group. Header format:
  `${title} - Session ${current} of ${total}`. Constructor takes
  `{ title, autoDismissMs, minVisibleMs }`.
- `getLoadingProgressModal(options)` — module-level lazy singleton.
  Refreshes `_singleton.title` and re-renders the header on each call.
  Without this, the first caller's title sticks forever — session-swap
  after a project import would otherwise still read "Importing project"
  instead of "Loading videos".
- `resetLoadingProgressModal()` — test-only helper to drop the singleton.

**Imports from project modules.** None.

**Imported by.** `ui/sessions-panes.js` (switchSession), `loading/session-loader.js`
(handleLoadVideos), `import-export/save-load.js` (handleLoadProject V3 path),
`import-export/slp-import.js` (handleLoadSlpFile per-cam loop).

**User-facing features.** Bottom-right per-camera progress rows during
session switching and initial-load workflows. Auto-dismisses ~500 ms
after all tasks complete; stays open on error.

**Notes / caveats.**
- `_rebuildRootSnapshot` no-ops in real browsers (guarded by
  `this.root instanceof window.HTMLElement`). It only runs in headless Node
  test sandboxes where `appendChild` does not reflect children into
  `root.innerHTML`. Running it in a browser would replace the real DOM
  (including the progress-bar markup `_renderRow` appends) with a simplified
  label-only snapshot — hiding every bar.
- Long session names truncate with ellipsis at the modal max-width (380 px)
  rather than forcing horizontal expansion. CSS: `.lpm-group-label` is
  `flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;` with `.lpm-group-row { min-width: 0; overflow:
  hidden; }` to allow label shrinkage and `.lpm-icon { flex: 0 0 auto; }`
  to keep the status icon at fixed width.

---


### ui/layout-controls.js

**Purpose.** Resizable split-handle bar between video grid, 3D viewport,
info panel, and timeline.

**Key exports.**
- `setupDragHandle(handle, onDrag)` — attaches mouse-drag listener to a
  split-handle DOM element.
- `setupSplitHandles()` — wires every split handle in the page.

**Imports from project modules.**
- `./app-state.js` — `viewport3d`, `timeline`.
- `./ui-wiring.js` — `syncTimelineToggleButton`,
  `updateInfoPanelToggleBtn`, `toggleInfoPanel`.

**Imported by.** `pose/initialization.js`.

**User-facing features.** Drag-to-resize panel boundaries between video
grid / 3D / info-panel / timeline.

---

### ui/overlays.js

**Purpose.** Pure canvas-rendering helpers for skeleton overlays, color
palettes, and per-frame draw routines. Receives `frameGroup` and
`instanceGroups` already resolved by the caller — no project imports.

**Key exports.**
- Node markers: `drawNodeShape(ctx, x, y, shape, size, color)` — draws one
  keypoint marker in one of four styles (`'circle'`, `'x'`, `'triangle'`,
  `'square'`). All 2D node draws route through it: `drawSkeleton`
  (normal + nulled nodes, via `options.nodeShape`), `drawReprojectedSkeleton`
  (via `options.nodeShape`, default `'x'`), and `drawUnlinkedInstances`
  (`instNodeShape`). `drawFrameOverlays` threads the per-type Node Style toggle
  through as `nodeShape: {user,predicted,reproj}Opts.nodeStyle`.
- Color: `TRACK_COLORS`, `REPROJECTION_COLOR`, `UNGROUPED_USER_COLOR`,
  `NULL_ID_COLOR` (space gray `#a7adba` for explicit-none instances when
  coloring by identity), `getTrackColor`, `getGroupColor`,
  `getInstanceColor`, `adjustColorBrightness`, `errorColor`, `hexToRgb`,
  `brightenColor`, `desaturateColor`, `complementaryColor`.
  `getGroupColor`/`getInstanceColor` return `NULL_ID_COLOR` when
  `useIdentity` and `session.isExplicitNoIdentity(...)` is true, and also —
  when coloring by track — for any instance/group on the "No ID" track
  (`session.isNoIdTrack(trackIdx)`), so the null track matches the ID
  panel's gray on the skeleton. **When coloring by identity,
  `getGroupColor` resolves the identity from the per-frame map keyed by the
  group's LIVE `trackIdx` (`getIdentityForTrack`) FIRST, using
  `group.identityId` only as a fallback for a group with no per-frame entry
  (issue #155). `group.identityId` is refreshed only on the frame an identity
  is (re)assigned, so consulting it first painted the pre-fix identity on every
  other frame after a swap fix propagated forward — the same staleness reason
  the track-color path already ignores `group.identityId`. The explicit-no-id
  sentinel is checked AFTER the `group.identityId` fallback so it never
  overrides a validly-assigned group identity (precedence unchanged for that
  case). The per-frame `trackIdx` probe is per-camera-local, so it is only
  ever queried paired with the SAME camera it came from. If a specific
  `cameraName` was requested AND the group has a real instance there, THAT
  view's own `(camera, trackIdx)` pair is the ONLY candidate — it is
  authoritative and never falls through to a sibling camera's identity, even
  if its own per-frame entry is absent or an explicit no-identity marker
  (issue #168 follow-up: a sibling camera's identity is not this view's
  answer). Only when there's no specific view to be authoritative for — no
  `cameraName` given at all (the 3D-viewport color callback), or the group
  has no real instance in the requested `cameraName` (a reprojection into a
  false-negative view) — does it search every OTHER member camera the group
  has a real instance in (in `group.instances` iteration order), trying each
  pair's `getIdentityForTrack`/`isExplicitNoIdentity` lookup correctly paired
  with its own camera. It NEVER calls `getIdentityForTrack` with no
  `cameraName`: that triggers its "search any camera in the whole frame for
  this trackIdx NUMBER" fallback, which matches purely on the number and can
  hit a completely unrelated group/animal that happens to share the same
  per-camera-local trackIdx (issue #168: duplicate-colored reprojection AND
  duplicate-colored 3D instances — the 3D-viewport color callbacks,
  `pose/initialization.js`/`ui/export-modals.js`, call `getGroupColor` with no
  `cameraName` at all since they have no per-view concept, so they always hit
  this wildcard mode before the fix). Regression tests:
  `tests/test-overlays.js` "getGroupColor identity path across cameras
  (issue #168)" (covers the reprojection case, the camera-agnostic 3D-viewport
  case, the own-camera-authoritative-over-a-sibling case, multi-camera
  fallthrough with 3+ cameras, null-trackIdx instances, and a fully empty
  group).**
  **First-frame Track-color collision (2D viewer, not the Timeline):**
  `commitTrackedFrame`'s (`pose/tracker.js`) `writtenThisFrame` guard marks a
  (frame,cam,rawTrackIdx) key `-1`/ambiguous in `frameIdentityMap` when the raw
  per-camera tracker briefly assigns the SAME trackIdx to two DIFFERENT
  animals on one frame — most common on frame 0, before it has history to
  differentiate them (`-1` is written nowhere else, so this is unambiguous).
  The Track-color path used to color purely by that raw trackIdx with no
  awareness of the collision, so on a collision frame two different animals
  resolved to the exact same `getTrackColor(sharedTrackIdx)` — reproducible
  immediately after Track All, with no Propagate step needed (the
  Identity-color path above was already fine — its own `group.identityId`
  fallback happened to cover this case). Fixed: when the group's own resolved
  `(camera, trackIdx)` is flagged `isExplicitNoIdentity` for this exact frame,
  fall back to the group's own `identityId` (unambiguous, never shared
  between two colliding groups) — mirroring the existing "no trackIdx at all"
  fallback a few lines below it. Regression test:
  `tests/e2e/first-frame-viewer-color-collision.mjs` (forces the exact
  collision on frame 0 only, asserts both display modes give the two animals
  distinct colors on frame 0 and that each animal's Track-color matches
  between frame 0 and frame 1 — confirmed it fails pre-fix, showing both
  animals as the identical color on frame 0, and passes post-fix).
- Geometry: `videoToCanvas`, `makeVideoToCanvasTransform`,
  `computeLabelOffset`, `getLineDashPattern`.
- Skeleton drawing: `drawSkeleton`, `drawReprojectedSkeleton`,
  `drawReprojectionErrors`, `drawSelectionHighlight`,
  `drawHoverHighlight`, `drawDragPreview`, `drawInstanceLabels`,
  `drawInstanceTypeIndicator`, `drawUnlinkedInstances`.
- Node trails (issue #102): `drawNodeTrails(ctx, viewName, session, frameIdx,
  options)` — mirrors SLEAP's TrackTrailOverlay. The window is the last
  `options.trailLength`+1 **present** frames up to and including `frameIdx`
  (sparse-aware, like SLEAP's `labels.find(video,
  range(0,frame_idx+1))[-trail_length:]`; only reads frames already in
  `session.frameGroups`, so no lazy-H5 fetch — the perf concern in #102). Draws a
  trail for **every track that appears anywhere in the window** (linked AND
  unlinked via `trailViewInstances`, matched by per-view `trackIdx`) — including
  tracks that have **vanished** from the current frame, so a trail lingers and
  fades out rather than disappearing the instant its instance is gone (unlinked
  matters too: identities are inspected BEFORE cross-view linking). Each node's
  positions join into a polyline that toward the past thins, fades, and darkens;
  each segment is colored by the instance's color AT that frame (per-frame identity
  lookup), so an identity/color **switch shows as a color change along the trail**.
  `drawFrameOverlays` calls it right after the canvas clear (behind the live
  skeletons) when `options.trailLength > 0`. Length is chosen from the **Tracks ▸
  Node Trails** submenu (Off/10/50/100/250/500 → `state.trailLength`).
- Composite: `drawFrameOverlays(ctx, viewName, frameGroup,
  instanceGroups, session, options)` — the main per-view draw entrypoint.
  `options.trackingExcluded` (set by `rendering.js` from `isCameraTracked`)
  recolors everything drawn for the view to a flat grey via a `source-atop`
  wash (drawn before the legend), signalling a Tracking-Wizard-excluded view.
  **ID overlays:** in identity color mode (`options.colorByIdentity`) it now
  labels **predicted** instances with their identity name/color (step 3a), not
  just user instances — so the cross-view tracker's output (predicted) shows its
  IDs as text for proofreading. `options.trailLength` threads through to
  `drawNodeTrails`. Covered by `tests/test-node-trails.mjs`.
- Misc: `drawLegend`, `getFrameStats`.

**Imports from project modules.** None.

**Imported by.** `pose/initialization.js`, `ui/timeline.js`,
`ui/rendering.js`, `ui/info-panel.js`.

**User-facing features.** All on-canvas pose drawing — colored skeletons,
reprojection error vectors, drag preview, selection highlight, instance
labels, occluded/null markers.

---

### ui/rendering.js

**Purpose.** Per-frame multi-view overlay rendering pipeline. Glues
`overlays.js` draw routines to the live `state` + `triangulation.js`
data sources. Plus visibility-toggle helpers and frame counter updates.

**Key exports.**
- `setReprojErrorVisible(visible)` — show/hide the reproj-error info
  column.
- `getVisibilitySettings()` — reads per-view checkbox state from the DOM.
  Each of `userOpts` / `predictedOpts` / `reprojOpts` now carries a `nodeStyle`
  (`'circle'`/`'x'`/`'triangle'`/`'square'`) read from the per-section Node
  Style button group (`visUserNodeStyle` / `visPredNodeStyle` /
  `visReprojNodeStyle`). Defaults: user `'circle'`, predicted `'x'`, reproj
  `'circle'` — reproj matches the 3D viewer marker (also `'circle'`) per
  issue #95. (`drawReprojectedSkeleton`'s own primitive fallback stays `'x'`
  for direct callers; the user-facing default comes from here.)
- `drawAllOverlays(frameIdx)` — main per-frame redraw across every view. Threads
  `state.colorByIdentity` and `state.trailLength` (node-trail length, issue #102)
  into each `drawFrameOverlays` call. **Playback throttle (issue #115):** the
  skeleton overlays + video redraw every frame, but the two *auxiliary* updates —
  `updateFrameInfo` (info-panel DOM + reproj-error aggregation) and
  `timeline.setCurrentFrame` (a full timeline-canvas `redraw()`) — are coalesced
  to ~10 Hz (`AUX_UPDATE_MS`) while `state.isPlaying`, since neither is legible at
  playback speed and both were a per-frame cost capping buffered-playback fps.
  When paused (seek/step) they run every call; `VideoController.stopPlayback`
  fires one final unthrottled `drawAllOverlays` so the panel/playhead settle to
  the exact stop frame.
- `updateFrameCounters()` — updates status-bar frame counters.

**Imports from project modules.**
- `./app-state.js` — `state`, `interactionManager`, `timeline`.
- `../pose/triangulation.js` — `ensureLazyFrameData`,
  `getInstanceGroupsForFrame`, `triangulateAndReproject`,
  `storeReprojectedInstances`.
- `./overlays.js` — `drawFrameOverlays`.
- `./settings.js` — `isCameraTracked` (passed to `drawFrameOverlays` as
  `trackingExcluded` so views excluded in the Tracking Wizard render grey).
- `./identity-assignment.js` — `editGroupState`, `finishEditGroup`.
- `./info-panel.js` — `updateFrameInfo`.

**Imported by.** `pose/triangulation.js`, `pose/tracker.js`,
`pose/initialization.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `loading/session-loader.js`,
`ui/identity-assignment.js`, `ui/export-modals.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** Every overlay redraw — after seek, drag,
re-triangulate, identity assignment, or visibility-toggle change.

---

### ui/sessions-panes.js

**Purpose.** Dockview pane manager (video panes), the view strip, the
sessions panel, the session strip, the move-video modal, session
add/remove/switch, and view-strip thumbnails. Owns the on-screen
multi-video docking layout.

**Key exports.**
- `panelRenderers` — Map of panelId → VideoPaneRenderer.
- `multiSelectViews`, `clearMultiSelect`.
- `refreshPaneInteractions`.
- `clampRotation`, `syncRotationUI`.
- `populateViewStrip`, `populateSessionsPanel`, `populateSessionStrip`.
- `showMoveVideoModal`.
- `removeSession`, `switchSession` (async).

**Imports from project modules.**
- `./app-state.js` — `state`, controllers + setters.
- `../pose/pose-data.js` — `FrameGroup`, `UnlinkedInstance`, `Camera`.
- `../pose/triangulation.js` — `triangulateAndReproject`,
  `storeReprojectedInstances`, `getInstanceGroupsForFrame`,
  `sessionHasCalibration`.
- `../loading/session-loader.js` — `cellResizeObserver`,
  `createViewForVideoFile`, `rebuildVideoController`,
  `fitCanvasesToCells`, `updateTotalFrames`.
- `../loading/video.js` — `OnDemandVideoDecoder`.
- `../import-export/save-load.js` — `setStatus`, `showLoading`,
  `hideLoading`.
- `./rendering.js` — `drawAllOverlays`, `setReprojErrorVisible`.
- `./info-panel.js` — `updateInfoPanel`.
- `./identity-assignment.js` — `autoAssignState`.
- `../pose/initialization.js` — `setup3DViewport`.

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`,
`ui/identity-assignment.js`, `ui/ui-wiring.js`,
`loading/session-loader.js`, `import-export/save-load.js`,
`import-export/slp-import.js`.

**Decoder pool cold reserve.** `switchSession` maintains
`state._decoderPoolCold[]` alongside `state.decoderPool[]`. When the
incoming session has fewer cameras than the outgoing one, surplus pool
slots are popped into the cold reserve with a 60-second `setTimeout` that
closes the decoder on expiry. The next switch's pre-extend block reuses
cold-reserve decoders first (cancelling their eviction timers) before
constructing new `OnDemandVideoDecoder` instances. This caps pool length
at the current session's camera count without immediately destroying
recently-used decoders.

**Per-session timeline height (Phase-7 refinement).** `switchSession`
saves the user's customized timeline height on the **outgoing** session
(`oldSession._timelineHeight`, `oldSession._timelineCollapsed`) and
restores it on the **incoming** session. First-visit sessions (no
saved height) get a default fit via `Math.min(timeline.getPreferredHeight(),
0.3 * window.innerHeight)`. The save/restore is **inlined** — it uses
`document.getElementById` rather than importing `timeline-controller.js`,
so the brace-walked `switchSession` test harnesses
(`test-session-switch-frame-reset.js`,
`test-switchsession-parallel-decoders.js`) don't need an additional
stub parameter. The same constraint shapes the inlined
`_uploadedCameras` recompute earlier in the function.

**Active-session memory model — dirty prompt + eviction.** `switchSession`
prompts Save/Discard/Cancel when leaving a dirty outgoing session
(`_leaving.isDirty`, tracked per-session by `markDirty`/`clearDirty` in
`import-export/save-load.js`) before switching. Once resolved (Save runs
`quickSave()` then proceeds only if it cleared the dirty flag; Discard
proceeds, dropping the changes), `switchSession` frees the outgoing session's
lazy state: if `_leaving.lazyLoader` is set, it's closed and
`frameGroups`/`instanceGroups`/`triangulationResults` are reset. For a
multi-session project this is usually a no-op by this point — a successful
`quickSave()` routes through `saveAllSessionsStreaming`
(`import-export/save-load.js`), which already evicted every session's
`lazyLoader` as part of saving — but it's what actually reclaims the memory
for a single-lazy-session project (whose streaming save doesn't touch
`session.lazyLoader`) or the Discard path (no save happened at all).
Re-activating an evicted session later requires reopening it from scratch
(the existing "load session folder" path) — there's no lazy re-hydration
from within one already-open project `.slp` yet.

**User-facing features.** Video pane docking (drag/move/resize), view
strip (top), session strip (bottom), per-pane brightness/rotation
controls, switch-session UX, move-video-between-sessions modal.

**Visibility-tab toggle list refresh (Block 2 / Prompt 4).** After
`timeline.setData(newSession)`, `switchSession` calls
`populateTimelineVisibility(newSession)` (added to the existing
`info-panel.js` import to preserve the brace-walked test contract — no
new top-level imports are introduced). This re-renders the Views /
Tracks / Identities toggle lists so they reflect the newly-active
session's `_hiddenCameras` / `_hiddenTracks` / `_hiddenIdentities`
Sets. Hidden-set state lives directly on each `session` object, so
**no explicit save/restore** is needed in `switchSession` — switching
back to a prior session naturally restores its toggle state (and
V7b-style isolation is automatic). The call is wrapped in a `try` so
the headless test runner doesn't crash on a missing `document`.


---

### ui/settings.js

**Purpose.** Central user-settings store: the default triangulation method
(`'dlt'` | `'ba'`, default `'dlt'`), per-skeleton-node **tracking weights**
(name → weight in `[0,1]`, default `1`), per-camera **tracking inclusion**
(name → `0|1`, default `1` = view participates in tracking; `0` = excluded from
the association math but still shown in the GUI), the cross-view **tracking thresholds**
(`TRACKING_THRESHOLDS` catalog — Tier A scoring knobs, Tier B reprojection gates,
and the benchmark-derived levers `track3dWeight` / `filterMinVisibleNodes` /
`filterMinInstanceScore`; see `pose/tracker.js`), plus a comprehensive **catalog
of every keyboard shortcut**
(`ACTION_CATALOG`). Settings persist to `localStorage` (`lucid.settings.v1`) and
survive reloads. The catalog is the single source of truth for the Settings ▸
Keyboard Shortcuts panel — see the keyboard-shortcuts note in `CLAUDE.md`.

**Catalog entries.** `{ id, label, category, binding, editable, dispatched }`.
`binding` is a "+"-joined accelerator (modifier tokens: `Mod` = Ctrl-or-Cmd,
`Ctrl`, `Cmd`/`Meta`, `Shift`, `Alt`/`Option`/`Opt`; last token is the key) for
dispatched entries, or a free-form display string (e.g. `← / →`, `1 – 9`) for
fixed reference entries. `dispatched:true` → matched live and needs a runtime
handler via `setHandler`; `dispatched:false` → handled by its own dedicated
handler elsewhere and listed for reference only.

**Key exports.**
- `getDefaultTriangulationMethod()` / `setDefaultTriangulationMethod(method)` —
  read/write the default method used by implicit triangulation paths.
- `getNodeWeight(name)` / `getNodeWeights()` / `getNodeWeightArray(nodeNames)` /
  `setNodeWeights(map)` — read/write per-node tracking weights (clamped to
  `[0,1]`; entries equal to the default `1` are dropped). `getNodeWeightArray`
  resolves a parallel weight array for an ordered node-name list — the form the
  tracker consumes (indexed to match `Instance.points`).
- `getCameraWeight(name)` / `isCameraTracked(name)` / `getCameraWeights()` /
  `setCameraWeights(map)` — read/write per-camera tracking inclusion (coerced to
  `0|1`; entries equal to the default `1` are dropped so only excluded views
  persist). `isCameraTracked` is the boolean the tracker filters cameras by
  (`pose/tracker.js` `trackAll`/`trackCurrentFrame`); at least 2 views must stay
  included or tracking aborts with a warning.
- `getTrackingThresholdDefs()` / `getTrackingThreshold(id)` /
  `getTrackingThresholds()` / `setTrackingThresholds(map)` — read/write the
  tracker's user-editable thresholds. `getTrackingThresholdDefs` returns the
  wizard's render catalog `[{ id, label, default, value, min, max, step, desc }]`,
  **filtered to `WIZARD_THRESHOLD_IDS`** — the CrossViewTracker's free parameters
  only (`filterMinVisibleNodes`, `filterMinInstanceScore`, `corr2dWeight`,
  `corr3dWeight`, `velocityThreshold`, `distanceThreshold`, `timePenalty`). The
  remaining catalog entries (`epipolarDecay`, `reprojSigma`, `epipolarWeight`,
  `reprojWeight`, `minMatchScore`, `prevIdentityBonus`, `reprojGate2/3/4`,
  `track3dWeight`) drive the bench-only luc3d matcher and are hidden from the UI
  but still resolve via `getTrackingThreshold`. `getTrackingThresholds` returns
  the effective `{ id: value }` map the tracker snapshots per run; values clamp to
  range and entries equal to the default are dropped.
- `getActions()` — catalog snapshot `[{ id, label, category, binding,
  defaultBinding, editable, dispatched }]` with effective bindings, for the modal.
- `getBinding(id)` — effective binding string (user override or catalog default).
- `setHandler(id, fn)` — attach the runtime handler for a dispatched action.
- `matchesBinding(id, e)` — true if a `KeyboardEvent` triggers the action under
  its effective binding (single-chord only; for external owners like
  `timeline-controller`).
- `dispatchEvent(e)` — resolve a `KeyboardEvent` to a dispatched action and run
  its handler (skips when typing in inputs); returns `true` if handled. Supports
  **multi-key sequence** bindings (chords separated by spaces, e.g. `"g t"`) via a
  rolling keystroke buffer with a 1.2 s gap reset; single-chord bindings fire
  immediately, the longest matching sequence wins (ties → catalog order). A
  binding may be one chord (`Mod+Shift+I`) or a sequence (`g t`).
- `applyBindings(map)` — commit an `{ id: binding }` override map (editable-only;
  non-default, parseable chord/sequence strings; defaults dropped);
  `resetBindings()` clears all.
- `formatBinding(str)` — prettify a binding for display; renders the `Mod`
  token as **Cmd** on Apple devices and **Ctrl** elsewhere (via
  `navigator.platform`), so the Hot Keys modal and Settings panel show the
  device-appropriate modifier.

**Imports from project modules.** None.

**Imported by.** `ui/ui-wiring.js`, `ui/identity-assignment.js`,
`ui/settings-modal.js`, `pose/tracker.js`.

---

### ui/settings-modal.js

**Purpose.** Builds and shows the "Settings" modal (opened from Help ▸
Settings). Wizard-style layout: a left nav (`settings-nav`) of categories and a
right panel area (`settings-panel-container`), with a Cancel / Apply footer.

**Key exports.**
- `showSettingsModal(initialPanel)` — `initialPanel` ∈ `'triangulation'` |
  `'keyboard'` | `'wizard'` (default `'triangulation'`). Single-instance.

**Behavior.** Three panels: **Default Triangulation** (single-select DLT/BA
radio rows, initialized from `getDefaultTriangulationMethod()`), **Keyboard
Shortcuts** (the full `getActions()` catalog grouped by category — editable
entries get a click-to-capture key chip that records a **chord or a multi-key
sequence**: keep pressing keys (the primary Ctrl/Cmd modifier is normalized to
`Mod` via `chordFromEvent`) until you click anywhere to set, or Esc to cancel,
with duplicate-binding rejection; fixed entries
render a greyed, dashed reference chip), and **Tracking Wizard** (three sections:
**Node Weights** — one row per node of the active session's skeleton with a
number field, range `0–1`, step `0.01`, seeded from `getNodeWeight(name)`; a `0`
drops the node from the CrossViewTracker's association cost and greys the row
(`.settings-view-excluded`), with a hint when no skeleton is loaded; **Camera
Views** — one row per camera of the active session with a binary `0/1` number
field seeded from `getCameraWeight(name)`; a `0` excludes that view from tracking
and greys the row, with a hint when no cameras are loaded; and **Tracking
Thresholds** — one labelled+described number field per `getTrackingThresholdDefs()`
entry (the CrossViewTracker's free parameters only; legacy luc3d thresholds are
filtered out), range/step from the catalog). All edits mutate a local `working`
state only (only editable bindings are tracked); nothing commits until **Apply**
(`setDefaultTriangulationMethod` + `applyBindings` + `setNodeWeights` +
`setCameraWeights` + `setTrackingThresholds`), which then repaints overlays +
timeline so excluded views grey immediately. Cancel / close `×` / backdrop click
/ Escape discard. A
capture-phase document keydown listener makes the modal fully capture the
keyboard (background shortcuts don't fire while it's open) and is removed on
teardown.

**Imports from project modules.** `./settings.js` (`getDefaultTriangulationMethod`,
`setDefaultTriangulationMethod`, `getActions`, `applyBindings`, `formatBinding`,
`getNodeWeight`, `setNodeWeights`, `getCameraWeight`, `setCameraWeights`,
`getTrackingThresholdDefs`, `setTrackingThresholds`); `./app-state.js`
(`getActiveSession`, `state`, `timeline`); `./rendering.js` (`drawAllOverlays`,
for the post-Apply repaint).

**Imported by.** `ui/ui-wiring.js`.

**User-facing features.** Settings modal — choose default triangulation method,
remap keyboard shortcuts, set per-node tracking weights, and exclude camera views
from tracking (Tracking Wizard, also reachable via Tracks ▸ Tracking Wizard).

---

### ui/timeline.js

**Purpose.** SLEAP-like canvas timeline showing track occupancy bars,
frame markers, and current-frame indicator. Click-to-seek, drag-scrub,
shift-drag range select, mouse-wheel / pinch zoom, middle-click pan. Block 1 (Prompt 4)
adds tree-grouped per-camera labels, an inner scrollable track-area
wrapper, and an empty-camera placeholder row per camera without tracks.
Rows whose camera is excluded from tracking in the Tracking Wizard
(`isCameraTracked(name)` false, imported from `./settings.js`) render grey —
both the gutter label and the occupancy bars — distinct from the
per-session visibility filter (`_hiddenCameras`), which drops the row entirely.

**Canvas backing-store cap.** `resize()` clamps the canvas backing store to
`MAX_CANVAS` (32000px/side). A tall timeline (e.g. 8 views × their tracks/
identities) makes `getPreferredHeight() * devicePixelRatio` exceed the browser's
~32767px `<canvas>` limit, which fails to allocate and renders as the broken-
canvas "sad face" over just the timeline region. When that would happen the
effective device-pixel ratio is scaled down (CSS size + scroll unchanged; only
backing resolution drops) so the canvas always allocates.

**Trackpad / wheel semantics.** `_handleWheel` maps wheel input as:
horizontal-dominant scroll (`|deltaX| > |deltaY|`) pans `_scrollFrame`
left/right (same axis as middle/right-drag pan and the scrollbar thumb),
`preventDefault()`-ing only when the pan actually moved; **Shift+wheel**
scrolls the track rows vertically via `_trackScrollEl.scrollTop`; and a
**plain wheel** — or Ctrl/Cmd+wheel, or trackpad pinch (browsers translate
pinch into `wheel` with `ctrlKey: true`) — zooms the time axis anchored on
the frame under the cursor (scroll up / pinch-out = zoom in, down = out).
The plain-wheel zoom is the requested mouse behavior; row scrolling moved to
Shift+wheel so it isn't lost. `_trackScrollEl`'s `overflow-y: auto` still
provides native scrolling via the scrollbar thumb. macOS's overlay
scrollbar is defeated via `-webkit-appearance: none` on the
`.timeline-track-area::-webkit-scrollbar` rule in `styles.css` so the
bar is always visible (not just on idle-fade) while the content
overflows; `scrollbar-gutter: stable` keeps the canvas width steady
when the bar appears/disappears.

**Key exports.**
- `Timeline` — class. Selected methods: `setData(session)`,
  `setCurrentFrame(frameIdx)`, `setTotalFrames(n)`, `setZoom(level)`,
  `scrollTo(frameIdx)`, `resize`, `redraw`, `destroy`,
  `setDisplayMode(mode)`, `refreshTracks(session, opts?)`,
  `setFrameModified(frameIdx, modified)`, `getPreferredHeight`,
  `getCameraGroups`, `getLabelLines`, `getRowCount`,
  `getTrackAreaElement`.

**Initial-load 40% cap.** `setData(session)` sizes the container via
`_fitContainerToData()`, which clamps the container height to
`[preferred, floor(0.3 * window.innerHeight)]`: a small track set shows
fully (no forced empty space), while a set taller than 30% of the window
caps at 40% and the inner `_trackScrollEl` scrolls. (Previously `setData`
called the uncapped `_growContainerToFit`, so a freshly loaded project
displayed every row.) `refreshTracks` stays grow-only so a height the
user expanded mid-session is never clipped.

**Segment draw clipping.** `_computeSegmentDrawRect()` draws wide segments
(`rawWidth >= minSegW`) at their true extents clipped to the visible
content rect, so a bar scrolled partly off-screen shrinks to its visible
slice; only narrow segments get the min-width center-and-clamp treatment.
This fixes a bug where panning left/right made wide track bars "fill
in/out" (a wide segment whose midpoint scrolled off-screen was clamped to
the content edge and stretched across the whole row).

**`refreshTracks` size-preserving mode.** Default `refreshTracks(session)`
rebuilds segments, calls `_growContainerToFit` (grow-only), then
`resize()`. Pass `{ keepSize: true }` to skip both — segments rebuild,
canvas repaints, but the outer container height AND the canvas pixel
dimensions stay exactly as the user left them. This is the path used
by Block 2 visibility toggles in `ui/info-panel.js`: without it,
`resize()` recomputes the canvas height as `max(naturalHeight,
availableHeight)`, and hiding rows drops the natural term so the
canvas shrinks down to `availableHeight` — visibly pulling the
playhead / marker row / frame-number labels up to the new bottom even
though the outer frame doesn't move. Track add / rename / delete
paths still use the default mode so the container expands to keep
new rows visible. Pass `{ cap: true }` to re-apply the initial-load 30%
cap (`_fitContainerToData`) instead of growing without bound — used after
Track All / Track Frame, Triangulate (current / all / group-by-identity),
the Propagate IDs↔Tracks actions, and multi-frame identity assignment, all
of which can add many rows at once, so the panel re-clamps to 30% and
scrolls rather than taking over the screen.

**Imports from project modules.**
- `./overlays.js` — `getTrackColor`.

**Imported by.** `pose/initialization.js`.

**User-facing features.** Bottom timeline widget — seek, scrub, zoom,
range-select, modified-frame markers, per-track occupancy bars,
display mode toggle. Each camera renders as a tree-grouped block
(`┌─` / `├─` / `└─`) in the label gutter with the **camera name drawn
in bold** so it pops against the regular-weight track / identity names;
cameras with no tracks still occupy one placeholder row (`camName ──`).
When the natural row count exceeds the timeline container height, the
track area scrolls vertically while the mode-toggle / playhead chrome
stays fixed.

**Label gutter sizing (Block 1 + Phase-7 refinements).**
- `LEFT_MARGIN` is **dynamic** — recomputed each `_rebuildSegments` by
  `_recomputeLeftMargin()`. Per spec, the gutter is sized to the
  longest name **in the currently viewed tab** (`tracks` / `identities`
  / `both`); switching tabs may therefore resize the gutter to fit
  that tab's data. Clamped between `MIN_LEFT_MARGIN = 100` and
  `MAX_LEFT_MARGIN = 280`.
- Labels are drawn as **three columns** rather than one right-aligned
  string. `_recomputeLeftMargin()` measures the three column widths
  separately and `_drawTrackBars` positions each piece at its own X:
  ```
  [LABEL_LEFT_PAD][ camName ][GAP][ connector ][trackName ]
                    bold,         left-align    left-align
                    right-align   at fixed X    at fixed X
  ```
  The connector column uses `_connectorForRole(role)` which returns
  bracket-only glyphs of equal character-width (`┌─ ` / `├─ ` / `└─ `
  / `── ` / `──`). Because every row's bracket starts at the same X,
  `┌─`, `├─`, and `└─` line up vertically within each camera group —
  regardless of how long individual track / identity names are. The
  camera name is drawn in bold and only on the anchor row of each
  group (`first` / `only` / `empty`); other rows show only the
  connector glyph (the `├`/`└` vertical strokes visually carry the
  tree's continuation line, no separate `│` glyph is rendered).
- Recursion-safety contract: `_finalizeTreeGrouping()` does NOT call
  `_recomputeLeftMargin()` — `_rebuildSegments()` is the sole caller
  (after finalize). The contract is preserved for parity with any
  future cross-mode sandbox that wants to recompute labels without
  re-entering the margin path.
- Composed `_trackNames` strings (returned by `getLabelLines()` and
  used by tests) embed the camera name on `first` / `only` / `empty`
  rows and a literal `│` continuation on `middle` / `last` rows.
  These strings are **inspection-only**; the draw path computes
  visual positions from `cameraName` / `trackName` / `treeRole`
  directly.

**Both-mode empty-camera dedupe.** In `'both'` display mode,
`_rebuildSegments` runs the tracks build and the identities build
sequentially, then merges by camera. For cameras with no tracks AND
no identities, both passes would emit a placeholder — the merge keeps
exactly one (`emptyEmittedForCam` flag) so the gutter doesn't show
the same empty camera twice.

**3D-points-only projects.** `_rebuildSegments` first checks
`_is3DPointsProject(session)` — true when the session has no cameras but its
`instanceGroups` carry `group.points3d` (skeleton + `handleLoadPoints3dH5`).
The normal per-camera builders enumerate `session.cameras` and so produce zero
rows in that case, leaving an empty track panel. `_build3DPointsSegments`
instead builds one row per track/identity directly from the InstanceGroups
(occupancy = frames where the group has ≥1 non-null 3D keypoint), colored by
`getTrackColor(identityId)`, under a synthetic `'3D'` camera group so the
existing tree-grouping / draw / visibility paths work unchanged. Covered by
`tests/test-timeline-3dpoints.js`.

**Sparse occupancy + row cap (phase-5, lazy `.slp`).** `_buildTrackSegments` reads
`session.trackOccupancy` two ways: the worker/analysis path supplies a **dense**
`{ data, nTracks, nFrames }` grid (scanned per frame), while a lazy `.slp`
(`SioLazyLoader._computeSparseOccupancy`) supplies **sparse** run-segments
(`{ sparse:true, segments:Map<trackIdx,[{start,end}]>, counts }`). The `occ.sparse`
branch uses those segments directly, subtracting materialized frames via
`_subtractFramesFromSegments` (binary-search split — for materialized frames the live
`fg.instances` data wins) instead of expanding a 108k-frame grid. To keep a
~1000s-track prediction dump from overflowing the canvas cap and being unreadable, the
per-camera row build **caps** at `MAX_TRACK_ROWS_PER_CAMERA` (32): **per camera** it
keeps the first-N tracks by **appearance** (earliest segment start — no extra I/O),
preserving track-index display order, and appends a label-only `+N more` truncation
row. The producer's per-track `counts`
(occupancy) is kept as metadata but no longer drives the cap. Normal (few-track)
sessions are under the cap and render exactly as before. Covered by
`tests/test-timeline-sparse-occupancy.js`.

**ID Timeline population after lazy eviction.** `_buildIdentitySegments` (the
identity-mode counterpart to `_buildTrackSegments` above) had the same lazy-
loading gap `_buildTrackSegments` already solved for tracks, but nobody had
fixed it for identities: it built `idCamFrames` **exclusively** from
`session.frameGroups`, which after a lazy reopen (#167) only contains frames
the user has actually visited — so the ID Timeline only showed color for
played frames instead of the whole tracked range (symptom: "colored IDs only
show up for frames we've played" after Track All / Triangulate All). Fixed
with a two-pass build: pass 1 is the original `frameGroups` scan, unchanged
and AUTHORITATIVE for whichever frames it covers; pass 2 is a NEW fallback
that iterates `session.frameIdentityMap` directly (parsed via the local
`_parseFrameIdentityKey(key)` helper — uses `indexOf`/`substring`, NOT
`split(':')`+`slice`/`join`, since this runs once per map entry on every
rebuild and a large project's map can have hundreds of thousands of entries;
measured ~3.5-4x faster at 100k frames (276ms → 72ms for
`setDisplayMode('identities')`) from avoiding the extra array allocations
alone, no caching involved. Splits on the first colon for frameIdx, the LAST
colon for trackIdx, so a colon-containing camera name still parses correctly;
mirrors the equivalent inline parsing in `ui/track-identity-ops.js`'s
`deleteTrackAt`) for every frame pass 1 didn't already cover. There is
currently no caching — the full pass re-runs on every `setDisplayMode`/
`setData`/`refreshTracks` call, so repeated mode-toggling on a huge project
still costs the same each time; a bigger follow-up would cache the built
segments and invalidate only when `frameIdentityMap`/`frameGroups`/
`instanceGroups` actually change. `frameIdentityMap` is the right fallback
source (rather than mirroring `_buildTrackSegments`'s
`instanceGroups`+`trackOccupancy` merge):
it's restored/written for the WHOLE tracked range regardless of frame
materialization (Track All / `groupByIdentityAndTriangulateAll` both write
it per-frame as they process every frame; nothing ever evicts it per-frame —
confirmed by grepping every `frameIdentityMap` reference in the repo), it's
tiny (one integer per assignment vs. full 2D pose data), and its raw value
already IS the answer (`>= 0` → identityId, `< 0` → explicit no-identity),
so it also natively covers the gray "No ID" row for unvisited frames, which
`instanceGroups` can't represent at all (ungrouped/unlinked instances are
never part of any group). One accepted, self-healing tradeoff: an instance
deleted via `removeInstance`/`removeInstanceGroup` doesn't clean up its
`frameIdentityMap` entry, so an unvisited frame could show a stale color bar
until visited — pass 1 (materialized frames) always wins once a frame is
actually visited, so this self-heals and is not treated as a bug to engineer
around. Covered by `tests/test-timeline-tree-grouping.js` ("Timeline ID
population after lazy eviction").

**Visibility panel row sizing (Phase-7 refinements).** `styles.css`
scopes a **compact** 28×16 `.toggle-switch` (knob 12×12, travel 12px)
to `.vis-toggle-row .toggle-switch` so the narrower toggles fit cleanly
in the per-camera / per-track / per-identity rows without dominating
the row width; the standard 40×22 size is preserved everywhere else in
the panel. `#visTimelineCameras` is additionally styled as **borderless
tabular rows** with subtle separators (no internal scrollbar) since
cameras are a small, finite count — Tracks and Identities retain the
scrollable `.vis-toggle-list` container.

**Test fixture — flex layout (T7 browser-runner fix).**
`tests/test-timeline-scroll.js`'s `createContainer()` sets
`display: flex; flex-direction: column` on the test wrapper so
`_trackScrollEl`'s inline `flex: 1 1 auto; min-height: 0` actually
constrains its height. The browser test runner at
`tests/test-runner.html` does not load `styles.css`, so the production
`.timeline-container { display: flex; ... }` rule isn't applied — the
test must mirror it inline to exercise the same scroll behavior as
production.

**Visibility filter (Block 2 / Prompt 4).** `_buildTrackSegments` and
`_buildIdentitySegments` tag every pushed row with `_isTrack: true` or
`_isIdentity: true` (including empty placeholders). After the build/merge
finishes, `_rebuildSegments` calls a new `_applyVisibilityFilter(session)`
pass — placed AFTER the both-mode interleave and BEFORE
`_finalizeTreeGrouping` so the filter can rewrite `_trackSegments` and
the tree-role pass sees the final row list.

The filter inlines `ensureHiddenSets` (so `timeline.js` does not import
`timeline-visibility.js`) and fast-path returns when all three hidden
Sets are empty — Block 1 behavior is therefore byte-for-byte preserved
for any fresh session, which is what makes the Block 1 scroll /
tree-grouping tests still pass unchanged.

Filter algorithm (per camera group, in row order):
1. If `cameraName ∈ session._hiddenCameras`, drop the whole group — no
   header placeholder is emitted. View-level precedence beats per-row
   track/identity toggles.
2. Otherwise, walk each row: keep `treeRole === 'empty'` placeholders;
   drop rows whose `trackName` is in the matching hidden Set (using the
   `_isTrack` / `_isIdentity` marker to pick the Set). Defensive fallback
   for un-flagged rows defaults to the `_hiddenTracks` check.
3. If the camera HAD any real row pre-filter but ends up with zero kept
   after filtering, strip remaining empty placeholders and emit a single
   `{ treeRole: 'empty', isAllHidden: true, cameraName }` row so the
   camera header survives in the gutter.

`_finalizeTreeGrouping` propagates `isAllHidden` from the placeholder
row onto `_cameraGroups[i].isAllHidden`. `_drawTrackBars` reads
`track.isAllHidden` on anchor rows and substitutes a dim
`rgba(255,255,255,0.25)` fill for the bold camera name (the prior
`fillStyle` is restored after, so subsequent rows draw normally). The
**all-hidden** placeholder is visually identical to Block 1's
**calibration-only / no-data** placeholder except for that dim color.

---

### ui/timeline-controller.js

**Purpose.** Timeline toggle/fit/shortcut controller (Block 1 / Prompt
4). Encapsulates collapse/expand with prior-height cache, fit-to-data
sizing (capped at 30% of `window.innerHeight`), the toolbar-button
sync helper, and the Ctrl/Cmd+J (toggle) / Ctrl/Cmd+Shift+J ("Change
Frame Number") keyboard-shortcut installer. Has zero transitive
`app.js` imports so it can be bridged into the test runner.

**Key exports.**
- `toggleTimeline`, `fitTimelineToData`, `syncTimelineToggleButton`,
  `installTimelineShortcuts`, `getCachedTimelineHeight`,
  `setCachedTimelineHeight`.

**Imports from project modules.**
- `./app-state.js` — `state` (for `state.timeline`).

**Imported by.** `pose/initialization.js`, `ui/ui-wiring.js`
(re-exports the same surface so legacy `import { toggleTimeline, … } from
'./ui-wiring.js'` keeps working).

**User-facing features.** Ctrl/Cmd+J toggles the timeline (remembering
its prior height); Ctrl/Cmd+Shift+J fires the legacy "Change Frame
Number" inline edit on the bottom-bar frame counter. When collapsed,
the timeline is **fully hidden** — the 40px `min-height` baseline of
`.timeline-container` is overridden by the `.collapsed` CSS rule
(`height: 0 !important; min-height: 0 !important`), so no track rows
peek through. The 8px `.split-handle.horizontal` above the container
stays visible and provides the click-and-drag affordance to expand
the timeline back up without using the keyboard.

---

### ui/timeline-visibility.js

**Purpose.** Block 2 (Prompt 4) — per-session Views / Tracks / Identities
visibility toggles for the timeline. Owns the toggle API, the source-of-truth
lists used by the **Info Panel → Visibility → Timeline** subsection, and the
membership queries that `ui/timeline.js`'s `_applyVisibilityFilter` reads at
build time. Module is stand-alone — **no imports** from other project modules,
so it loads cleanly in the headless node test runner without dragging in
`app.js`.

**Key exports.**
- `ensureHiddenSets(session)` — lazy-init `session._hiddenCameras`,
  `session._hiddenTracks`, `session._hiddenIdentities` as empty `Set`s.
  Idempotent; called at the top of every helper so callers never null-guard.
- `toggle{Camera,Track,Identity}Visibility(session, name)` — flip Set
  membership. Returns the new visible boolean.
- `is{Camera,Track,Identity}Visible(session, name)` — `true` if not hidden.
- `list{Cameras,Tracks,Identities}ForVisibility(session)` — `string[]`. The
  camera list is filtered by `session._uploadedCameras` (matching the
  timeline's own filter) so calibration-only cameras don't appear in the
  toggle list.
- `get{Camera,Track,Identity}VisibilityList(session)` — `[{ name, visible }]`
  (identity rows also include `id` and `color`). Track-row swatch color
  is intentionally NOT set by this module — `ui/info-panel.js` decorates
  each track entry with `getTrackColor(i)` after the list returns so this
  module can stay free of `./overlays.js` (and the wider import graph) and
  load cleanly in the headless node test sandbox.
- `renameHiddenTrack(session, oldName, newName)` /
  `renameHiddenIdentity(session, oldName, newName)` — migrate hidden-set
  membership when the user renames a track / identity, so the toggle stays
  applied to the renamed entity.

**Per-session state.** Lives directly on the `session` object as `Set<string>`
fields (keyed by entity NAME, including identities). Empty by default — fresh
sessions / new entities default to visible. Naming convention `_foo`
mirrors Block 1's `_timelineHeight` / `_timelineCollapsed`. **In-memory only**;
no round-trip through `save-load.js` (intentional per Block 2 spec — toggles
don't persist across project reload).

**Global mirror.** Bottom of the file exposes the same surface on
`window.TimelineVisibility.*` and individually on `window.toggleCameraVisibility`
etc., guarded by `typeof window !== 'undefined'`. The mirror is what the
browser test runner and the headless node sandbox use to resolve the API
under either lookup style.

**Imports from project modules.** None.

**Imported by.** `ui/info-panel.js` (toggle helpers + list helpers),
`ui/ui-wiring.js` (rename-migration helpers). `ui/timeline.js` intentionally
does **not** import this module — it inlines its own `ensureHiddenSets`
equivalent so the timeline core stays decoupled from the visibility-panel
wiring.

**User-facing features.** Backs the **Info Panel → Visibility → Timeline**
subsection (Views / Tracks / Identities lists). Toggling off any entity
hides the matching rows in the timeline. Camera (View) precedence: hiding a
camera hides every row for it; hiding individual tracks/identities leaves
the camera header visible (gray, "all hidden" placeholder) so the user can
still see which camera has its content collapsed.

---

### ui/track-identity-ops.js

**Purpose.** Pure, DOM-free operations backing the Tracks-menu New / Rename /
Delete modals (which live in `ui/ui-wiring.js`). Extracted so the substantive
logic is unit-testable headlessly — `ui/ui-wiring.js` itself can't be loaded in
the test runner (app.js import graph).

**Key exports.**
- `nameExists(session, kind, name)` — duplicate-name guard (`kind` =
  `'track' | 'identity'`).
- `countNulledByCamera(session, kind, idx)` → `{ perCamera, total }` — the
  Delete modal's per-camera breakdown of instances that will be nulled. Identity
  counting uses the **canonical per-frame identity source**
  (`session.getIdentityIdForTrack(cam, trackIdx, frameIdx)`), NOT
  `group.identityId` (which is only populated after triangulation — reading it
  left the Delete-Identity table empty/stale).
- `deleteTrackAt(session, idx)` — first **ungroups** any GroupedInstance that
  uses the deleted track (`session.unlinkGroup`, members return to the unlinked
  pool); then splices the track, nulls every instance on it (`trackIdx = null`,
  the app-wide trackless sentinel — NOT -1, which crashes the overlay renderer),
  and shifts higher `trackIdx` down. Covers frameGroups (linked + unlinked) AND
  any remaining GroupedInstances explicitly, with a `seen` set so shared instance
  refs aren't double-decremented. Also remaps the `frameIdentityMap` keys
  ("frame:cam:trackIdx") in lockstep — deleted-track entries move to the
  trackless (`null`) key, higher ones shift down — so an instance keeps its
  identity when it loses its track (instead of the per-frame entries orphaning
  or misattributing). Returns the name.
- `deleteIdentityAt(session, idx)` — **ungroups** every GroupedInstance carrying
  the id (matched via `group.identityId` OR, pre-triangulation, via the per-frame
  `getIdentityIdForTrack`; falls back to nulling `group.identityId` in sessions
  without `unlinkGroup`), clears the per-frame `frameIdentityMap` entries pointing
  at it (so instances resolve to "no identity"), splices the identity, and drops
  the hidden-identities entry. Returns the name.

**Imports from project modules.** None (operates on the passed `session`).

**Imported by.** `ui/ui-wiring.js`. Bridged into `tests/test-runner.html` and
covered by `tests/test-track-identity-modals.js`.

---

### ui/ui-wiring.js

**Purpose.** Top-level UI wiring. Builds the menu bar, transport controls,
keyboard handlers, visibility tab, view-mode (grid/single) switching,
playback rate, and re-exports popular helpers like `unlinkGroup`,
`showGroupContextMenu`, `seekToLabeledFrame`, `fitTimelineToData`. Transport
buttons and the Arrow/Home/End keyboard handlers route through
`navigateToFrame` (from `initialization.js`) so frame stepping works in a
video-less skeleton + imported-3D-points project as well as with video. When
there is no `videoController`, play/pause (the `btnPlay` button and the spacebar)
drive a private timer-based stepper (`startNoVideoPlayback` /
`stopNoVideoPlayback` / `toggleNoVideoPlayback`) that advances frames at
`state.fps` over `[0, totalFrames-1]`, rendering each via `navigateToFrame` and
stopping at the last frame; the step transport buttons/keys stop it first.

**Key exports.**
- Menu / setup: `setupMenus`, `setupUI`. The Tracks menu hosts both
  identity↔track propagation actions (one-shot): `Propagate Tracks → IDs`
  (`menuPropagateTracksToIds` — creates an identity
  per track and assigns it to every group; sets `session.trustTracks`; was the
  old Edit-menu "Trust Track Labels" toggle) and `Propagate IDs → Tracks`
  (`menuPropagateIdsToTracks` — calls `Session.propagateIdentitiesToTracks`).
- Color-by toggle: the "Color by" Tracks/ID control lives in the top
  toolbar (buttons `colorByTracks` / `colorById`, next to the Errors
  checkbox), not the Tracks menu. `updateColorByToggle()` reflects
  `state.colorByIdentity` on the buttons; each button's click sets the
  state, re-renders the 2D overlays via `drawAllOverlays` AND the 3D viewer
  via `update3DViewport` (whose `getGroupColor` closure reads
  `state.colorByIdentity` live, so instances recolor instantly), and updates
  the active class.
- Node Style: the four per-section Node Style button groups
  (`visUserNodeStyle` / `visPredNodeStyle` / `visReprojNodeStyle` /
  `vis3dNodeStyle`) reuse the `.line-style-btn` click handler (active toggle +
  `data-value` + `drawAllOverlays` + `saveVisSettings`); they are added to
  `visStyleIds` for persistence/restore. The handler additionally rebuilds the
  3D skeleton for `vis3dNodeStyle` (`viewport3d.skeletonNodeShape = …; setFrame`).
- File ▸ "Export 3D Video" (`menuExportVideo3d`) is wired to
  `showExport3DVideoModal()` (export-modals.js).
- Session strip: the **"+"** button (`btnAddSession`) calls
  `handleEmptySession()` to create a fresh empty session directly (inheriting the
  shared project skeleton — the user then adds video via File ▸ Load Videos);
  the **"−"** button (`btnRemoveSession`) calls `removeSession`. Folder-based
  session loading stays on the File menu (`menuLoadSessionFolder` →
  `loadSingleSessionFromCache`, `menuLoadMultiSessionFolder`).
- Group ops: `unlinkGroup`, `performGroupButtonAction` (shared by the toolbar
  Group button and the `Shift+G` shortcut — context-sensitive group/ungroup),
  `showGroupContextMenu`, `hideGroupContextMenu`.
- Instance copy/paste (`copySelectedInstance` / `pasteInstance`, wired via
  `setHandler` to catalog ids `copyInstance` (Mod+C) / `pasteInstance` (Mod+V)).
  Copy snapshots the selected UserInstance in the focused view (a grouped
  selection's instance in `lastInteractedView`, or `selectedUnlinked`) into the
  app-state instance clipboard as a node-name→point map plus the source
  skeleton's `compatibilityKey()`. Paste validates the target session skeleton's
  key matches, remaps the points into the target node order **by name** (so node
  ordering may differ across sessions), and reuses
  `interactionManager._addNewInstance(points)` to drop a `user` instance into the
  focused video at the current frame at the **exact copied coordinates** (allowed
  to land out-of-bounds when video sizes differ). Status strip reports
  `UserInstance copied/pasted in Video <v> Frame <n>` or
  `Paste not supported for different skeletons!`. Occlusion flags are not carried
  (coordinates + per-node visibility are).
- Seekbar: `updateSeekbar`, `updateSeekbarVisual`,
  `onPlaybackStateChange`.
- Toggles: `toggleInfoPanel`, `updateInfoPanelToggleBtn`,
  `toggle3DViewport`, `toggleTimeline`, `syncTimelineToggleButton`,
  `fitTimelineToData`.
- View modes: `toggleViewMode`, `cycleSingleView`, `setGridMode`,
  `updateVideoGridDisplay`, `showViewIndicator`.
- Playback: `applyPlaybackRate`, `seekToLabeledFrame`.

**Imports from project modules.** Nearly every other module — see file
header for the full list. Notable ones: `app-state.js`,
`timeline-controller.js`, `pose-data.js`, `triangulation.js`,
`rendering.js`, `info-panel.js`, `save-load.js`, `slp-import.js`,
`file-io.js`, `session-loader.js`, `video.js`, `tracker.js`,
`initialization.js`, `identity-assignment.js`, `export-modals.js`,
`sessions-panes.js`, `settings.js`, `settings-modal.js`.

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`,
`ui/layout-controls.js`, `loading/session-loader.js`,
`import-export/slp-import.js`.

**User-facing features.** Menu bar (File / Edit / Tracks / View / Hot Keys,
plus a right-aligned Help menu), transport controls (play/pause/seek/speed), keyboard shortcuts (Space,
arrows, T, A, etc.), grid/single view toggle, info-panel/3D/timeline
visibility toggles, "seek to next labeled frame".

**Help menu + Settings.** The right-aligned (`margin-left:auto`) menu is
**Help** (its dropdown opens right-aligned via `right:0`): `menuDocumentation`
opens the docs site (`https://talmolab.github.io/luc3d-docs/`) in a new tab;
`menuSettings` opens the Settings modal via `showSettingsModal()`
(`ui/settings-modal.js`). The Tracks menu's `menuTrackingWizard` item opens the
same modal focused on the Tracking Wizard panel via `showSettingsModal('wizard')`,
as does the **`Mod+T`** shortcut (catalog id `openTrackingWizard`, handled by the
dedicated keydown block). The **Hot Keys** modal (`showHotkeysHelp`,
`menuHotkeys`) is generated from `getActions()` — the same `ACTION_CATALOG`
snapshot that drives Settings ▸ Keyboard Shortcuts — so it stays in sync with the
catalog and any user rebindings (grouped by category; Esc closes it).

**Triangulate dropdowns + default method.** The toolbar `Triangulate` /
`Triangulate All` are **split buttons**: clicking the button itself runs the
user's default method (`getDefaultTriangulationMethod()` from `ui/settings.js`),
while hovering reveals a menu for picking DLT / BA explicitly. `wireTriDropdown`
wires both the button click (default method) and the menu items (explicit
picks). Implicit triangulation — the `t` shortcut, the Edit ▸ Triangulate menu
item, and the auto-assign flow in `identity-assignment.js` — also uses the
default method.

**Track / Identity menu modals.** The `Tracks` menu's New / Rename / Delete
actions for both tracks and identities open shared private modal helpers in
`ui/ui-wiring.js`, each taking `kind = 'track' | 'identity'` (selecting data
source, title, and apply binding). All share the `.rename-list` scrollable list
styling (yellow selection via `.rename-list-item.selected`) and the
`.multi-frame-modal` shell; all close on Esc (replacing the old `prompt()`
chains):
- `showCreateModal(kind)` — New Track / New Identity: read-only
  (`.rename-list.readonly`) reference list of current entries + a "New name"
  text entry. Cancel / Create; Enter creates. Validates non-empty + duplicate.
- `showRenameModal(kind)` — Rename Track / Rename Identity: single-select list +
  "New name for …" entry. Apply renames `session.tracks` /
  `session.identities[].name`, migrates hidden-set membership
  (`renameHiddenTrack` / `renameHiddenIdentity`). Enter applies.
- `showDeleteModal(kind)` — Delete Track / Delete Identity: single-select list, a
  red `.delete-warning` line ("Current track/identity "X" instances will have
  null …"), and — in place of a text entry — a per-camera table of instances
  that will be nulled with a `.delete-total-row` Total. Cancel / Delete (`.danger`
  button); deletion is an explicit click (NOT bound to Enter, since destructive).
The count + delete logic lives in `ui/track-identity-ops.js`
(`countNulledByCamera` / `deleteTrackAt` / `deleteIdentityAt`): both delete paths
first ungroup any GroupedInstance bound to the deleted track/identity, then track
delete nulls the trackIdx (remapping `frameIdentityMap` so identities follow) and
shifts higher indices down, while identity delete clears the per-frame
`frameIdentityMap`; both the count and delete use the per-frame identity source
(`getIdentityIdForTrack`), not `group.identityId`.
All apply paths refresh overlays / info panel / timeline (`keepSize`) /
visibility.

**Catalog-driven keyboard shortcuts.** Every **standard single-action** shortcut
is now dispatched: it attaches a runtime handler via `setHandler(id, fn)` (from
`ui/settings.js`) and is resolved by a single dedicated `keydown` listener
calling `dispatchEvent(e)`, so it is **editable and rebindable** (chords or
multi-key sequences) from the Settings panel. This covers the plain-key toggles
(`u`/`p`/`r`/`e`, `v`, `g`, `t`, `n`, `i` info, `\` 3D, `?`, `Shift+G` group,
`Shift+U` ungroup, `f` find), the track actions (`Shift+T`, `Mod+Shift+T`),
the wizard (`Mod+Shift+I`), smart-add new instance (`Mod+I`), settings
(`Mod+,`) and load-session (`Mod+O`). `Shift+G` (`group`) is wired to the **same** shared
`performGroupButtonAction()` as the toolbar Group button, so the key does exactly
what the button does: ungroup a selected group, create the group once ≥2 are
picked in assignment mode, or otherwise toggle assignment mode. Bindings live in `ACTION_CATALOG` (the
single source of truth for the Settings panel). The remaining shortcuts keep
their own dedicated handlers and appear as **fixed** reference entries (not
rebindable): `Mod+S` Save (works while typing), transport (`←/→`, `Space`,
`Home`/`End`, `Opt+←/→`), the `1–9` identity / `Shift+1–9` track digit ranges,
zoom (`+`/`-`/`0`), `Shift+R`+rotate, `Delete` plus the legacy `c`
confirm-group alias (`groupConfirmLegacy`, canvas-context ops in
`interaction.js`), and `Mod+J`/`Mod+Shift+J` (timeline-controller).
`Enter`/`Escape` remain hard-coded modal-button special cases.

**Block 2 (Prompt 4) visibility wiring + rename migration.** Every
track-add / track-rename / track-delete / identity-add / identity-rename /
identity-delete handler that already calls `timeline.refreshTracks` now
also calls `populateTimelineVisibility(state.session)` so the Visibility
panel's toggle lists stay in sync with the live entity lists. The
rename handlers additionally call `renameHiddenTrack` /
`renameHiddenIdentity` from `ui/timeline-visibility.js` **before** the
rename is applied to `session.tracks` / `session.identities`, so a
toggled-off entity retains its hidden state across the rename
(the Set entry is moved from old name to new name rather than left
stranded).


---

### ui/viewport3d.js

**Purpose.** Three.js 3D viewport that renders triangulated skeletons,
camera frustum wireframes, skeleton edges, camera position labels.
Self-contained — caller passes `cameras`, `skeleton`, color callbacks
via the options bag.

**Key exports.**
- `Viewport3D` — class. Selected methods: `setFrame(instanceGroups)`,
  `setSelectedInstance`, `setEnvironment`, `clearEnvironment`,
  `addCameraPyramids`, `selectCamera`, `showSelectedCameraView`,
  `showInitialView`, `setMissingVideoCameras`, `highlightCamera`,
  `resize`, `resetCamera`, `lookAtOrigin`, `fitToScene`, `dispose`.
- Constructor options `skeletonNodeShape` (`'circle'` sphere / `'square'` cube /
  `'triangle'` tetrahedron / `'x'` crossed bars — `updateSkeleton` builds the
  matching node geometry) and `preserveDrawingBuffer` (keeps the WebGL buffer
  after compositing so the canvas can be captured frame-by-frame; used by the
  Export 3D Video modal). A second `Viewport3D` can be mounted in the export
  modal's container, reusing this class rather than duplicating 3D code.

**Imports from project modules.** None (uses the global `THREE` from CDN
script tags).

**Imported by.** `pose/initialization.js`.

**User-facing features.** 3D viewport panel — orbit camera, click camera
frustum to fly to that view, "Show Initial View" reset, environment
overlay (skeleton meshes around tracks).

---

## loading/

### loading/frame-worker.js

**Purpose.** Worker that uses `SLPPackageReader` + h5wasm-lazy-files to
extract embedded video frames from `.pkg.slp` files via HTTP range
requests. Spawned by `import-export/slp-import.js` (twice — for two
loading paths). Module-typed worker.

**Message protocol.**
- IN: `{type: 'loadUrl', url}` / `{type: 'loadFile', file}` — open SLP
  package.
- IN: `{type: 'getVideos'}` — list embedded videos.
- IN: `{type: 'getFrame', videoKey, embeddedIdx}` — extract one frame.
- IN: `{type: 'findFrame', videoKey, displayFrame}` — find embedded
  index for a display frame.
- IN: `{type: 'close'}`.
- OUT: `{type: 'ready'}`, `{type: 'log', message, level}`,
  `{type: 'videos', videos}`, `{type: 'frame', bytes, format, ...}`,
  `{type: 'error', error}`.

**Imports from project modules.**
- `./slp-package-reader.js` — `SLPPackageReader`.

**Imported by.** Spawned via `new Worker(new URL('../loading/frame-worker.js',
import.meta.url), {type: 'module'})` from `import-export/slp-import.js`
(two call sites).

**User-facing features.** Loading `.pkg.slp` projects with embedded video
frames (off-main-thread to keep UI responsive).

---

### loading/session-loader.js

**Purpose.** Orchestrator for every session-loading workflow — empty
session, per-camera SLPs, single-SLP, multi-session, video-only,
calibration-only. Owns view/grid layout, video selection prompts,
filesystem enumeration, decoder rebuild.

**Key exports.**
- Loaders: `handleLoadCalibration`, `handleLoadVideos`,
  `handleLoadMultiSession`, `loadSingleSessionFromCache`,
  `handleLoadSessionFolder`, `handleEmptySession`,
  `handleLoadSessionFolderSingleSlp`,
  `handleLoadSessionFolderPerCamera`, `handleLoadProjectSlpLazy`,
  `attachVideosForLazyReopen`.
  `handleLoadSessionFolderSingleSlp()` loads a folder holding a project `.slp`
  plus `videos/` + calibration. It reads the SLP with the **typed** reader
  (`parseSlpViaSleapIO`, raw `parseSlpH5` only as fallback) and restores the
  project's saved state — `InstanceGroup` grouping, per-instance
  `nulledNodes`/occlusion, identities, 3D points — via the shared
  `restoreGroupingAndUnlink` (`import-export/slp-import.js`), so loading a
  project `.slp` reflects the changes saved in THAT file. (Previously it used
  the raw parser and rebuilt flat poses, dropping all of that.) Views are
  ordered by **calibration camera index**, not folder file-enumeration order,
  so the 2D panes don't reshuffle on reload.
  `handleEmptySession()` creates a blank, video-less session and makes it
  active (the session-strip **"+"** button calls it directly — see
  `ui/ui-wiring.js`). It **inherits the shared project skeleton** via
  `buildRememberedSkeleton()` so a manually-created empty session stays in sync
  with the others (one skeleton per project); only when it is the very first
  session does it mint a fresh blank `Skeleton` and register it with
  `setProjectSkeleton`. The user then populates it via File ▸ Load Videos.
- Video assignment: `autoAssignVideosToCameras`, `forceVideoSelection`,
  `forceVideoSelectionWithFolder`, `matchSessionFolder`,
  `pickParentDirectoryForSessions`, `showParentDirMatchSummary`.
  `forceVideoSelectionWithFolder(refInfo, sessionName, options)` accepts
  `options.allowSkip` (adds a "Skip — Load Videos Later" button that resolves
  `null`; used by the lazy project reopen) and closes on `Esc` (resolving
  `null`, per the modal UI convention) — every caller treats `null` as "no
  videos picked".
- `isCalibrationVideoFile(file)` — true for per-camera calibration clips
  (`<cam>/calibration_images/<date>-<cam>-calibration.mp4`). The folder scans
  recurse into camera subfolders, so these clips would otherwise be collected
  and substring-matched to a camera (their filename embeds the camera name).
  Applied in the parent-directory pick (both FSA + webkitdirectory branches),
  the "Select Session Folder" scan, and the SLP-import video filter so the
  calibration video never loads as a session view.
- View/grid: `createViewForVideoFile`, `updateGridLayout`,
  `createVideoPromptCell`, `fitCanvasesToCells`, `cellResizeObserver`,
  `rebuildVideoController`, `updateTotalFrames`.
- Session-mode UI: `showSessionModeModal`, `showMissingFilesPopup`.
- Filesystem: `enumerateDirectoryHandle`.
- Misc: `resolveImportTrackIdx` — re-exported from
  `import-export/import-track-resolve.js` (moved there so it's unit-testable;
  session-loader pulls app.js and can't be bridged into the test runner).

Fresh-session creation sites (video-only, calibration-only, multi-cam directory)
seed the skeleton from `buildRememberedSkeleton()` (falling back to an empty
skeleton), so a skeleton built/imported earlier in the app session carries over to
newly loaded videos. SLP/project load paths keep parsing their own embedded
skeleton via `parseSkeletonJSON`.

`handleLoadVideos` only uses `paneManager.addAllViewsAsGrid()` on the **first**
load (nothing docked yet); subsequent loads add just the newly created views via
the dedup-aware `paneManager.addVideoPanel(name, { direction: 'right' })`. This
avoids re-docking already-loaded videos as duplicate (non-interactable mirror)
panels — `addAllViewsAsGrid` intentionally bypasses the duplicate guard, so
calling it on every load duplicated prior videos and let the newest panel steal
each `view.canvas` reference.

`handleLoadVideos` scopes camera + view creation to the videos it loaded **this
call** (`newVideoFiles`), not the global `state.videoFiles`, and tags each with
`vf.sessionIdx = state.activeSessionIdx`. This matters when loading videos into a
pre-existing (e.g. manually-created empty) session while another session's videos
already exist globally: iterating the global list would skip a `session.cameras`
entry for the loaded view (its dummy-camera loop skips already-assigned videos)
and re-create other sessions' videos as views here. A session with a view but no
matching `session.cameras` entry made the timeline draw no rows (it builds rows
from `session.cameras`), so instances added there never appeared on the timeline.

**Per-camera `.slp` selection.** `handleLoadSessionFolderPerCamera` loads only
**one** `.slp` per camera directory — the highest `_vN` version (first-wins on a
tie / when unversioned). A camera dir accumulates successive exports
(`<stem>_v1.slp`, `_v2.slp`, …, e.g. from "Export SLEAP File Per Session"); only
the latest reflects current state. Parsing every file stacked all versions'
instances into the same (frame, camera) slot — the Instances tab then showed the
same tracks repeated N times. Skipped files are logged.

**Large `.slp` → lazy loading.** In `handleLoadSessionFolderPerCamera`, each
camera's chosen `.slp` is routed by `shouldUseLazySlp(bestSlp)` (`> 150 MB`): large
prediction files go to a `SioLazyLoader` (`./sio-lazy-loader.js`, sleap-io.js
streaming lazy reader) instead of the eager `parseSlpH5` worker, which OOMs the tab
on 100k-frame predictions. The lazy loader is chosen when all lazy jobs are `.slp`
(analysis `.h5` folders still use `LazyFrameLoader`); a lazy-open failure surfaces
an error rather than falling back to the OOM-prone eager path. It plugs into the
existing `state.session.lazyLoader` seam, so rendering/scrubbing are unchanged.

**Lazy project reopen (`handleLoadProjectSlpLazy`).** The memory-bounded "Load
Project" path for a large saved project `.slp` (routed here by
`handleLoadProject` in `import-export/save-load.js` via `shouldUseLazySlp`).
Opens the ONE interleaved multi-camera file with
`SioLazyLoader.openProjectSlp`, restores calibration + grouping/IDs/3D from the
typed `RecordingSession` via `reconstructInstanceGroupsFromSessionLazy`
(`import-export/slp-import.js`) — 2D hydrates on scrub — and brings up the 3D
view + timeline immediately. Because no decoders exist yet,
`updateTotalFrames()` (which reads decoder sample counts and resets to 0
without them) can't be used: the `#totalFrames` counter and
`timeline.setTotalFrames` are written directly from `loader.nFrames`
(`timeline.setData` alone does not propagate the frame span — the timeline
would clamp to 1). Once the data is up, `attachVideosForLazyReopen(session,
loader, pickedFilesOverride)` runs as the video-finalization step: it prompts
(`forceVideoSelectionWithFolder` with `allowSkip`; a project `.slp` references
videos by path only), matches each picked video to a session camera by
parent-directory name, camera-name-in-stem, or the referenced video filename
from the reopened file (`loader.videos`), spins up decoders in parallel
(progress modal), then creates views/panes, rebuilds the video controller, and
refines the frame counter via `updateTotalFrames`. Skippable (Esc / Skip
button, or all videos unmatched/failed) — the session then stays video-less
and File → Load Videos still works later. `pickedFilesOverride` bypasses the
prompt for tests/automation. Covered by `tests/test-lazy-reopen.js`.

**Imports from project modules.**
- `../ui/app-state.js` (incl. `buildRememberedSkeleton`), `../pose/pose-data.js`,
  `./video.js`, `../import-export/file-io.js`, `../pose/triangulation.js`
  (`shouldUseLazyH5`, `shouldUseLazySlp`, `LazyFrameLoader`),
  `./sio-lazy-loader.js` (`SioLazyLoader`),
  `../import-export/save-load.js`, `../ui/rendering.js`,
  `../ui/info-panel.js` (`updateInfoPanel`),
  `../import-export/skeleton-json.js` (`parseSkeletonJSON`),
  `../import-export/slp-import.js`, `../ui/loading-progress-modal.js`,
  `../import-export/import-track-resolve.js`,
  `../pose/initialization.js`, `../ui/sessions-panes.js`, `../ui/ui-wiring.js`.

**Imported by.** `pose/initialization.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `ui/info-panel.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** File menu Load Calibration / Load Videos /
Load Session Folder / Load Multi-Session (plus the lazy Load Project path for
large project `.slp`s, incl. its attach-videos prompt), all video-to-camera
auto-matching, session-folder mode chooser. `handleLoadSessionFolder` calls
`ensureNo3dImportBlockingLoad()` first, so loading a session over a
skeleton-only 3D-points import prompts before discarding it.

---

### loading/sio-lazy-loader.js

**Purpose.** Main-thread lazy frame loader for large prediction `.slp` files,
backed by sleap-io.js's streaming lazy reader (`readSlpStreaming({ lazy: true })`).
Drop-in for `LazyFrameLoader`'s interface so it plugs into the
`state.session.lazyLoader` seam unchanged — but holds one lazy sleap-io.js `Labels`
per camera on the main thread (the reader's own internal worker does the HDF5 I/O
off-thread and returns compact columnar arrays) rather than spawning a per-camera
worker. Frames are materialized on demand via `labels.frameAt(row)`, so
`getFrameSync` returns data synchronously.

**Key export.** class `SioLazyLoader` — `open(camName, file, onProgress)` (reads
metadata + builds a videoFrameIdx→store-row map, first camera's skeleton/tracks
win), `openProjectSlp(file, onProgress)` (lazy reopen of a SINGLE multi-camera
project `.slp` — the "Load Project" path for large projects: one interleaved
store shared by every camera, split into the same per-camera maps `open()`
builds; sets `_sharedStore = true` so the streaming re-save appends the store
ONCE, retains `videoIdByCam` (camName → NATIVE store video id, read from the
typed session's `videoByCamera` or the raw camcorder map) for the re-save's
video-id remap, and returns `{labels, typedSession, cameraNames, nFrames}` so
the caller can restore grouping/3D via
`reconstructInstanceGroupsFromSessionLazy`), `getFrame` / `getFrameSync` (adapt
typed instances → `{trackIdx, score,
type, points, occluded}`, LRU-cached), `prefetch`, `close` (also clears
`videoIdByCam`); fields `nFrames`,
`skeleton`, `trackNames`, `videos`, `trackOccupancy`, `videoIdByCam` (only set
by `openProjectSlp`; `null` on the per-camera `open()` path), `isSync = true` (so
`batchLoadLazyFrames` takes its worker-free path), and `sourceFiles` (camName →
the `File`/`Blob` it was opened from — a local-disk `File` is a cheap lazy
handle, not a resident copy of the bytes, so retaining these costs ~nothing and
lets a caller reopen a fresh loader for the SAME cameras later without
re-picking files; used by the multi-session streaming save's pass-2 restream,
`reopenSessionLazyLoader` in `import-export/save-load.js`).

`trackOccupancy` (phase-5) is populated per camera by `_computeSparseOccupancy(labels,
nFrames)` — one O(nInstances) pass over the columnar store (`framesData.frame_idx` +
`instance_id_start/end`, `instancesData.track`) emitting **sparse** per-track
run-segments `{ sparse:true, nTracks, nFrames, segments:Map<trackIdx,[{start,end}]>,
counts:Map<trackIdx,frameCount> }` — never a dense nFrames×nTracks grid (a ~108k×1000s
prediction dump would be huge). Relies on the SLP on-disk frame ordering (same invariant
`appendStore` assumes); zero frame materialization. `session.trackOccupancy` picks it up
(`session-loader.js`); the timeline reads the `sparse` flag (`_buildTrackSegments`) and
caps rendered rows (first-N per camera by appearance). See `ui/timeline.js`.

Memory-bounding primitives (phase-5 full pipeline): `open()` sets each camera's
`labels.frameCacheLimit` (default 512) so sleap-io.js's lazy `Labels` FIFO-bounds
its internal typed-frame cache automatically. `releaseFrame(frameIdx)` /
`releaseWindow(start, end)` explicitly drop a frame (or half-open range) from BOTH
the loader's adapted-dict LRU AND each camera's lazy `Labels` — via the **public**
`labels.releaseFrame(row)` API (row = the camera's videoFrameIdx→store-row), the
prompt release used by the windowed triangulate-all / streaming-export sweeps
(`sweepTriangulationFrames`, `ui/export-modals.js`). `store.materializeFrame`
rebuilds a dropped frame on next access, so release is safe. These use the public
frame-release API from sleap-io.js PR #208 — replacing the earlier private
`_lazyFrameList.cache` reach-in and manual `capInternalCaches` (now redundant, so
`evictLazyFrames` no longer calls it).

**Project-wide identity/track propagation primitives** (fix for "Propagate
IDs → Tracks only affects a handful of frames near the cursor" on a large
project): `forEachInstanceRow(visitFn)` — read-only sweep over every
`(camName, frameIdx, trackIdx)` instance triple in the WHOLE project, straight
from each camera's columnar store (`framesData.instance_id_start/end` +
`instancesData.track`) — zero frame/instance materialization, independent of
what's resident. Used by `Session.propagateTracksToIdentities`
(`pose/pose-data.js`) so an unvisited frame's track still gets stamped to
identity. `remapTracksFromIdentity(newTrackNames, remapFn)` — the write-side
companion, used by `Session.propagateIdentitiesToTracks`: rebuilds each
underlying `labels.tracks` (shared by reference with its
`_lazyDataStore.tracks` — mutated in place, so both stay in sync; a shared
project-`.slp` store is only rebuilt once) to `newTrackNames`, then for every
instance row calls `remapFn(camName, frameIdx, oldTrackIdx)` and writes the
result into `instancesData.track` in place — the same array `appendStore`
(export, `import-export/slp-streaming-write.js`) and `materializeFrame`
(re-materializing an evicted/revisited frame) both read by reference, so the
propagated track survives eviction/reload and is exported correctly with no
new writer plumbing. Also rebuilds THIS camera's `trackOccupancy` entry (via
`_computeSparseOccupancy`) from the just-remapped column — fixes a bug where
the Tracks Timeline never reflected a propagate on a lazy session: `session.
trackOccupancy` is the SAME Map object as `this.trackOccupancy` (aliased by
reference in `session-loader.js`), and `ui/timeline.js:_buildTrackSegments`
trusts it for every unmaterialized frame, so leaving it stale (as before)
meant the Timeline kept showing pre-propagate track bars for almost the whole
project while the 2D viewer (which reads the mutated columnar store directly)
was already correct. Invalidates the loader's own adapted-dict cache and each
camera's underlying sleap-io.js typed-frame cache afterward — via
`_lazyFrameList.clearCache()` (drops the whole cache in one call), not the
old per-row `releaseFrame(row)` looped over every frame row in the project
(up to ~900k calls on a 180k-frame × 5-camera project just to invalidate a
~512-entry cache — the dominant cost behind "Propagate IDs → Tracks takes
forever"); falls back to the old per-row loop if `clearCache` isn't present
on the bundle. Both are duck-typed feature checks from the `Session` side
(`typeof … === 'function'`), so the worker-backed `LazyFrameLoader` (SLEAP
analysis `.h5`, no columnar store) is unaffected.
**Error handling (regression for "export only has tracks on the first
frame(s), rest are trackless"):** the per-row remap loop and the whole
function used to have NO error handling — an exception thrown mid-row would
silently abort the remap for every camera/frame not yet processed, while
`frameIdentityMap`/`instanceGroups`/resident `Instance.trackIdx` (all fixed
up by `propagateIdentitiesToTracks` steps 1-3b, which run BEFORE this method)
would already be fully correct — exactly "GUI looks right, export is
broken past some point," with nothing in the console to explain why. Now:
each row's remap is wrapped in its own try/catch (one bad row is skipped,
logged, and left with its OLD track index rather than aborting every
subsequent row/frame); a per-camera console summary logs rows
visited/changed; the method returns `{changed, errorRows, firstError}`
instead of a bare number. `Session.propagateIdentitiesToTracks` logs
`frameIdentityMap.size` vs `oldKeyToNewTrackIdx.size` right before calling
this (a sparse `oldKeyToNewTrackIdx` relative to a dense `frameIdentityMap`
points at step 2's filtering, not this method) and folds `errorRows` into its
own return value; `ui/ui-wiring.js`'s propagate handler reports a nonzero
`lazyErrorRows` as an error status instead of a false "success".

**Imports.** `window.SleapIO.readSlpStreaming` (via the index.html bridge) and the
local vendored `lib/h5wasm/h5wasm.iife.js` (passed as `h5wasmUrl`).

**Imported by.** `loading/session-loader.js`
(`handleLoadSessionFolderPerCamera` routing, `handleLoadProjectSlpLazy`) and
`import-export/save-load.js` (`reopenSessionLazyLoader`).

**User-facing features.** Lets a session folder of large multi-camera prediction
`.slp` files — and a large saved project `.slp` (Load Project) — load and render
without OOMing the tab. Lazy project reopen is covered by
`tests/test-lazy-reopen.js`.

---

### loading/slp-import-worker.js

**Purpose.** Web Worker that runs h5wasm in a separate thread to parse
and lazily index SLP HDF5 files. Mounts File objects via WORKERFS for
zero-copy access. Two modes: full eager parse, or lazy
open-and-stream-frames.

**Message protocol.**
- IN: `{type: 'parse', file}` — full eager parse.
- IN: `{type: 'open', file}` — lazy open, return metadata only.
- IN: `{type: 'getFrame', frameIdx, requestId}` — read one frame lazily.
- IN: `{type: 'getFrames', startIdx, endIdx, requestId}` — read range.
- IN: `{type: 'close'}` — close lazy file.
- OUT: `{type: 'progress', message}`, `{type: 'result', data: {...}}`,
  `{type: 'metadata', data: {...}}`, `{type: 'frameData', ...}`,
  `{type: 'framesData', ...}`, `{type: 'error', message}`.

**Imports from project modules.** None.

**Imported by.** Spawned via
`new Worker(new URL('loading/slp-import-worker.js?v=' + Date.now(), document.baseURI), {type: 'module'})`
from `import-export/file-io.js` (eager parse) and `pose/triangulation.js`
(lazy reads). The `document.baseURI` resolution makes the URL work on
sub-path deployments (GitHub Pages `/luc3d/`, `/luc3d/pr/N/`) — see
ISSUES.md I-8.

**User-facing features.** SLP import progress without freezing the UI;
lazy frame loading for very large SLP files.

---

### loading/slp-package-reader.js

**Purpose.** HDF5 helper class for reading frame-extracted `.pkg.slp`
files. Knows how to enumerate `videoN` groups, read PNG/JPG byte
strings, and translate display frames ↔ embedded indices. Designed to
run inside a worker context with h5wasm available.

**Key exports.**
- `SLPPackageReader` — class. Methods: `open(url)` (range-request
  streaming), `openFile(h5File)`, `close`, `getVideos`,
  `getVideoInfo(videoKey)`, `getFrame(videoKey, embeddedIdx)`,
  `findEmbeddedIndex(videoKey, displayFrame)`,
  `findClosestFrame(videoKey, displayFrame)`,
  `hasFrame(videoKey, displayFrame)`, `getFrameRange(videoKey)`.

**Imports from project modules.** None (uses h5wasm passed in via
options bag).

**Imported by.** `loading/frame-worker.js`.

**User-facing features.** Backs frame extraction for `.pkg.slp` files
loaded over the network or from disk.

---

### loading/video.js

**Purpose.** Video decoding and multi-view playback. Hybrid HTML5
`<video>` + WebCodecs + mp4box.js decoder for frame-accurate seeking,
plus a `VideoController` that synchronises playback across all
overlay-paired video panes. In practice frame extraction always runs
through the HTML5 `<video>` path (`_getFrameHTML5`); mp4box is used only
to recover the true fps/frame-count, and the WebCodecs path stays off
(`_mp4Initialized` never set true) to avoid B-frame decode-order
mismatches. `_getFrameHTML5`'s seek guard uses a frame-rate-aware
tolerance (half a frame period, `0.5/_fps`) so high-fps recordings
(e.g. 400 fps) step every frame instead of freezing under a fixed
constant (issue #89).

**Frame-accurate mediabunny backend (default-on, issue #115).** HTML5
`<video>.currentTime` seeking is NOT frame-accurate — it can return a
frame a whole GOP behind the one requested, so the pose overlay (drawn
from correct, verified data) ends up on a stale video frame and fast
nodes like the tail visibly mismatch. By default `init()` builds a
`MediaBunnyVideoBackend` (from sleap-io.js, using the vendored
`lib/mediabunny/`) via `_initMediabunny(source)` and adopts its
authoritative frame count / fps; `getFrame()` then decodes exact frames
through mediabunny (`sink.getSample(_frameTimes[i])`), transparently
falling back to the HTML5 seek on any init/decode failure.
`_mediabunnyEnabled()` is ON unless
`LUCID_VIDEO_BACKEND` (from `window` or `localStorage`) is `'html5'` /
`'legacy'` — default-on (rather than opt-in) because `localStorage` is
per-origin, so an opt-in flag silently disables the fix on any origin
where it wasn't set (a PR preview vs localhost). Confirmed on real
hardware; note it couldn't be validated headless (headless *software*
decode is itself frame-inaccurate — every WebCodecs decoder, incl.
mediabunny and a raw `<video>`, shows the same offset). Pose data imports
and exports correctly regardless — this bug is display-only.

**Playback overlay/video sync — native default + per-frame throttling
(issue #115 follow-up).** During playback the pose overlay drifted a few
frames AHEAD of the video ("the tracking leads the video"; stepping one
frame snapped it back). The root cost was that per playback frame the app
ran three heavy updates in addition to the video+skeleton draw:
`updateFrameInfo` + timeline `redraw()` (throttled in `rendering.js`) and
`update3DViewport` — a full Three.js scene rebuild+render wired through
`updateSeekbar` (throttled in `ui-wiring.js`), plus per-frame `[3D]`
`console.log` spam (now gated behind `window.LUCID_3D_DEBUG`). With those
coalesced to ~10 Hz during playback, the native `<video>` +
`requestVideoFrameCallback` overlay keeps up frame-to-frame. **Native
playback is the default** (smooth); `VideoController.stopPlayback` fires a
final unthrottled overlay/seekbar update so info panel, timeline, and 3D
settle to the exact stop frame.

*Buffered mediabunny playback (`_startBufferedPlayback`) is OPT-IN* via
`window.LUCID_PLAYBACK_BACKEND='buffered'`/`'mediabunny'`
(`_bufferedPlaybackEnabled()`). It is VIDEO-LED and frame-accurate — a
producer (`pump(view)`) decodes CHUNK-sized ranges ahead of the playhead
into each backend's LRU cache (serialized per backend via `view._mbBusy`;
`cacheSize` bumped to `W+CHUNK+margin` and restored on stop), and a
wall-clock rAF loop advances `drawn` only to the newest frame `<= target`
decoded in EVERY view, then `paint(f)` draws each view's cached bitmap AND
the overlay for that SAME `f` synchronously, so the overlay can never lead
the video. BUT it is DECODE-BOUND: WebCodecs can't sustain real-time
multi-view HEVC decode, so it plays in choppy spurts — hence opt-in, not
default. Tunables: `LUCID_PLAYBACK_BUFFER` (frames ahead, default
`max(24, fps)`), `LUCID_PLAYBACK_CHUNK` (default 12), `LUCID_PLAYBACK_DEBUG`
(per-second fps / draw-ms / overlay-ms / underrun readout to diagnose
decode- vs overlay-bound). Frame-accurate STEPPING uses the mediabunny
backend on both paths. The sync invariant (overlay never leads) is
unit-tested with a mock backend (`tests/test-playback-buffered.js`);
smoothness can only be validated on real hardware.

**Zoom/pan resize anchoring.** Zoom pan offset (`view.zoom.offsetX/offsetY`) is
screen-space px relative to the wrapper's base display size, which `applyZoom`
records as `zoom.baseW/baseH`. When a cell is resized, `reapplyZoom` rescales the
offset by the base-size ratio (`offset *= newBase/oldBase`) before re-clamping, so
a zoomed-in image keeps the same region centered instead of jumping.

**Key exports.**
- `videoLog(msg, level)` — namespaced logger.
- `OnDemandVideoDecoder` — class. Selected methods: `init(source)`,
  `getFrame(frameIndex)`, `_initMediabunny(source)` /
  `_mediabunnyEnabled()` (opt-in frame-accurate backend, issue #115),
  `decodeRange(start, end)`, `playNative`, `pauseNative`, `seekNative`,
  `switchSource`, `close`, `drawCurrentFrame`.
- `EmbeddedVideoDecoder` — class for SLP-embedded frames. `getFrame`,
  `hasFrame`, `close`.
- `VideoController` — class. Selected methods: `seekToFrame`,
  `scrubToFrame`, `togglePlayback`, `startPlayback`, `stopPlayback`,
  `pausePlayback` (user-pause: stop + frame-accurate mediabunny step one
  frame forward so the video lands exactly on-frame with the pose overlay,
  issue #115 — the play button and spacebar call this, internal stops call
  `stopPlayback`),
  `_startBufferedPlayback` / `_bufferedPlaybackEnabled` (buffered
  video-led mediabunny playback, issue #115),
  `setupSeekbar`, `setupKeyboardHandlers`, `initZoom`, `applyZoom`,
  `zoomVideo`, `resetZoom`, `zoomToRect`, `zoomAllVideos`,
  `resetAllZoom`, `setupZoomHandlers`.

**Imports from project modules.** None (uses the global `MP4Box` from
script tag).

**Imported by.** `pose/initialization.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `loading/session-loader.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** All video playback (play/pause/seek/scrub),
zoom-in-on-rectangle, multi-view zoom sync, frame-accurate stepping,
keyboard transport.

---

## import-export/

### import-export/skeleton-json.js

**Purpose.** Pure, DOM-free (de)serialization for standalone `.skeleton.json`
files in the SLEAP jsonpickle node-link format. Split out of `ui/info-panel.js`
(which keeps only the download / file-picker wrappers) so the round-trip logic is
unit-testable without a browser.

**Key exports.**
- `buildSkeletonJSON(skeleton)` — returns the skeleton-JSON object (no I/O). Emits
  each node's full `py/object` (carrying its name) exactly once at first
  occurrence: in `links` if the node has an edge, otherwise in the `nodes` array.
  This fixes the prior bug where **edgeless nodes** (typically the trailing ones)
  lost their names on re-import and came back as `node_<i>`.
- `parseSkeletonJSON(jsonText)` — parses jsonpickle Format 1, plus the simpler
  `{skeleton:{…}}` and direct node/edge-array formats; returns a `Skeleton` or
  null.

**Imports from project modules.** `../pose/pose-data.js` — `Skeleton`.

**Imported by.** `ui/info-panel.js`, `loading/session-loader.js`. Tested by
`tests/test-skeleton-json.js`.

### import-export/file-io.js

**Purpose.** File-picker helpers, calibration parsing (TOML + JSON),
SLP-LABELS bytes-builder used by export, points3d / reproj H5 builders,
parser stubs that spawn `slp-import-worker.js`. The "low-level" file
layer.

**Key exports.**
- File pickers: `pickFiles`, `pickFolder`, `pickVideoFiles`.
- Calibration: `parseCalibrationTOML`, `parseCalibrationJSON`,
  `loadCalibrationFile`, `exportCalibrationTOML`, `downloadTOML`.
- Video matching: `matchVideosToCameras`, `buildVideoGrid`.
- SLP build: `buildSlpExportData`, `buildPerCameraSlpJson`,
  `buildSlpLabels`, `buildSlpLabelsAllViews`,
  `buildSlpLabelsMultiSession`, `serializeSkeleton`, `_buildSioPoints`
  (per-node `[x,y,visible,complete]` builder — nulled/occluded/optional
  per-point score; also reused by `slp-streaming-write.js` for edited-frame
  overlays).
  (PR 5.2 deleted `convertSlpToV06Compatible` — export is now raw
  `saveSlpToBytes`; SLEAP >= 1.6 / sleap-io >= 0.7 reads the flat-matrix
  `field_names` layout natively.) On 2D export both `buildSlpLabels` and
  `buildSlpLabelsMultiSession` keep each instance's own track — grouped
  AND ungrouped/unlinked — so a flat 2D project's tracks survive; an
  ungrouped instance only drops its track if a grouped instance already
  holds that track in the same frame (SLEAP forbids two instances sharing
  a (frame, track) pair). Reprojections still export trackless.
- SLP export (client-side): `exportSlpClientSide`,
  `exportSlpMultiSession`. For a **lazy session** these route a plain
  per-camera export through `lazyCameraExportBytes` → `saveSlpToBytes` on the
  camera's already-lazy `Labels` (the lazy fast-path — all frames,
  memory-bounded), instead of the eager `buildSlpLabels*` which iterates only
  the resident `frameGroups` (silent-drop) and would re-materialize. The
  multi-view project save uses the streaming writer via
  `slp-streaming-write.js` (see `save-load.js` / `buildSlpBytes`).
  **Regression fix ("Export SLEAP File Per Session"/"By Cam": after
  Propagate IDs → Tracks, the exported file only had track labels on the
  first frame):** the fast path used to be gated on a literal
  `!instanceFilter` check — but every export-modal call site
  (`ui/export-modals.js`) unconditionally builds a non-null `instanceFilter`
  object (`{ user: true, predicted, reprojected }`) to carry the
  Include-Predicted/Include-Reprojections checkbox state, even at DEFAULT
  settings — so that condition was never true and both export modals always
  silently fell through to the eager, frameGroups-only path (whatever's
  resident — often just the current frame right after Track All +
  Propagate). `instanceFilterAllowsLazyFastPath(instanceFilter)` replaces the
  literal check: the fast path now runs whenever the filter doesn't actually
  need anything it can't provide (no reprojections requested, predicted/user
  not explicitly excluded) — covering the default/common case, while still
  correctly falling back to the eager path when the user explicitly requests
  reprojections or excludes predicted/user instances.
  **Data-safety guard (never silently drop a manual correction):**
  `lazyCameraExportBytes` re-emits the RAW columnar store verbatim, with no
  notion of a live-edited `Instance` sitting in a resident `FrameGroup` — so
  it now checks every resident frame via a local `frameGroupHasUserInstances`
  (copied from the identical helper in `pose/tracker.js`/
  `ui/export-modals.js`) and returns `null` (falls back to the eager,
  correction-aware path) if ANY resident frame carries a user-type instance,
  rather than risk silently exporting the original uncorrected prediction in
  its place. Covered by `tests/test-lazy-export-instance-filter.js` (all-frame
  coverage via the fast path, and the correction-preservation fallback).
- `buildSlpLabelsAllViews` builds the full typed graph (RecordingSession /
  FrameGroup / InstanceGroup with `instance3d`, `identity`, and `metadata.lucid`)
  that `saveSlpToBytes` serializes — as of sleap-io.js 0.5.5 this is **SLP 2.8**:
  3D points + grouping go to the columnar `/session_data` group and `sessions_json`
  stays slim (calibration + video map + session metadata + frame-group range). It writes each
  session's identity list into `metadata.lucid.identities` AND each group's
  per-session index into `InstanceGroup.metadata.lucid.identityId` (authoritative on
  reload — the canonical `identity_idx`/`ig.identity` resolve against the file-level
  concat and mis-scope for multi-session files). The file-level `identities_json` is
  a cross-session concatenation, NOT the per-session source of truth on reload.
- Skeleton validation: `findSkeletonMismatch(selections)` — returns `null` when
  all selected sessions share a skeleton (node count + names, in order),
  otherwise a human-readable mismatch message. Pure (no SleapIO); used both to
  guard `buildSlpLabelsMultiSession` and to pre-flight the per-camera download.
- SLP parse (raw worker): `parseSlpH5(file, onProgress)` — spawns
  `slp-import-worker.js`. Kept for SLEAP analysis `.h5` and as the
  `parseSlpViaSleapIO` fallback.
- SLP parse (sleap-io.js, PR 5.1/5.2): `parseSlpViaSleapIO(file, onProgress)` —
  drives `window.SleapIO.readSlpStreaming(file, {rawSessions:true})` (PR #196)
  and adapts the typed `Labels` into the `slpData` shape via the private
  `_typedInstanceToSlpData` pose transform (columnar `_xy`/`_visible` →
  `points[]` + parallel `occluded[]`, NOT `numpy()`). Each `sessions[]` entry is
  the verbatim on-disk dict (for the direct calibration/video-map/metadata reads)
  PLUS a `_typedSession` ref (the typed RecordingSession) used by
  `reconstructInstanceGroupsFromSession` for grouping — which reads LUCID's legacy
  inline `frame_group_dicts`, the canonical `sessions_json`, and the SLP 2.8
  columnar `/session_data`. Streams via a `File` source; the reader's I/O worker
  loads LUCID's local vendored h5wasm IIFE via `h5wasmUrl` (no CDN fetch). Pose
  byte-parity with `parseSlpH5` + full 2.8 round-trip (calibration / 3D incl. NaN /
  identity / occlusion) verified in-browser.
- H5 build/parse: `buildPoints3dH5`, `buildReprojH5`,
  `buildPoints3dExportData`, `parsePoints3dH5`, `h5FileToBlob`.
- Misc: `downloadJSON`, `instancePointsMatch`.

**Imports from project modules.**
- `../pose/pose-data.js` — `Camera`, `Skeleton`, `Instance`, `Identity`.

**Imported by.** `import-export/save-load.js`,
`import-export/slp-import.js`, `loading/session-loader.js`,
`ui/export-modals.js`, `ui/ui-wiring.js`.

**User-facing features.** Underlies File menu Load Calibration / Load
Videos / Export TOML / Export SLP / Export H5; spawns SLP-parse worker.

---

### import-export/slp-streaming-write.js

**Purpose.** Memory-bounded SLP *save* for large lazy sessions (phase-5 full
pipeline) — the write-side companion to `SioLazyLoader`. The eager builder
(`buildSlpLabelsAllViews` + `saveSlpToBytes`) materializes one `Labels` with every
frame; on a ~108k×N lazy prediction session that re-OOMs and silently drops every
unvisited frame (it only iterates the resident `frameGroups`).

**Multi-session two-pass split (eric/fix-save follow-up).** `SIO.openSlpWriter`
serializes `sessions_json`/`identities_json` (+ the SLP 2.8 columnar `/session_data`
group holding 3D points + grouping) **synchronously at open time** (not
at `close()`), so every session's ref-based `RecordingSession` graph — with
correct file-**global** `lf_idx`/`inst_idx` (sleap-io resolves refs against one
flat, file-wide labeled-frames table, never per-session) — must be complete
*before* the writer opens, i.e. before any frame streams. For multiple large
lazy sessions that can never all be resident at once, this forces two passes,
each holding only one session's data at a time:
- **`createProjectWriterContext()`** — a fresh shared context
  (`{ runningOut, allSkeletons, allVideos, allTracks, allIdentities,
  trackBaseByNameSig }`) threaded through every session so refs stay
  file-global (never reset per session).
- **`buildSessionRefGraph(session, views, videoFiles, ctx)`** — PASS 1, per
  session: prunes `session.frameGroups` to user-edited frames only (frees the
  bulk of Track All's per-frame materialization before the rest of this
  function runs), builds the overlay plan / `storeOutIndex` / per-`InstanceGroup`
  refs against `ctx`'s running counter (advancing it for the next session), and
  accumulates this session's cameras/tracks/skeleton into `ctx`. Requires
  `session.lazyLoader` open and Track All/Triangulate All already run. Touches
  no writer. Returns `{ sioSession, overlayLfs, cam }` — small enough that the
  caller can safely evict the session's lazy loader/`frameGroups`/
  `instanceGroups` right after this returns.
  **Non-shared-store track dedup (regression: "export only has tracks on the
  first frame, the rest are empty"):** for separate per-camera prediction
  files (session-folder load, `loader._sharedStore` false), each camera's
  `labels.tracks` used to be blindly re-appended onto `ctx.allTracks` as a
  fresh copy under an ever-increasing `trackOffset` — correct when every
  camera's raw per-camera tracker genuinely has its own disjoint track list,
  but `Session.propagateIdentitiesToTracks` (`pose/pose-data.js`, via
  `remapTracksFromIdentity`, `loading/sio-lazy-loader.js`) rewrites EVERY
  camera's `labels.tracks` to the SAME identity-derived list — so every
  camera after the first re-appended a DUPLICATE copy of that now-identical
  list, and its instances pointed at that duplicate rather than the shared
  one. `ctx.trackBaseByNameSig` (a `'|~|'`-joined track-name-list signature →
  the `trackBase` it was first added at) dedups this the same way
  `skeletonByName` already dedups skeletons above — a camera whose track list
  exactly matches one already added reuses that base instead of duplicating.
  Two genuinely-different cameras' raw prediction tracks essentially never
  collide by coincidence, so this only ever fires for the real case: every
  camera sharing one identity-derived list post-propagate. Covered by
  `tests/test-slp-streaming-write.js`'s "propagateIdentitiesToTracks then
  export" test — two separate (non-shared-store) per-camera fixtures, a real
  propagate, a real streaming export, and a real readback asserting every
  frame from both cameras (not just the first) resolves a valid, correctly-
  named track.
- **`openProjectWriter(ctx, allSioSessions, provenance)`** — the single
  `SIO.openSlpWriter(...)` call, made once every session's ref graph is final.
- **`streamSessionIntoWriter(writer, session, refGraphResult)`** — PASS 2, per
  session: `appendFrames(overlayLfs)` + `appendStore(store, {videoIndexOffset,
  trackOffset})` per camera, using the offsets saved in pass 1. Requires
  `session.lazyLoader` to be (re)opened — no Track All/Triangulate All needed,
  `appendStore` reads straight from the columnar store (~1.2 GB peak for a
  108k-frame×3-camera session, not pass 1's ~3.7 GB).

**Shared-store re-save (lazy project reopen).** A session reopened via
`SioLazyLoader.openProjectSlp` has `loader._sharedStore` set: ONE interleaved
store holds every camera's frames, so `streamSessionIntoWriter` appends it
ONCE (appending per camera would rewrite the whole store N times — duplicate
frames + tracks). Two extra pieces make this correct for arbitrary inputs:
- `buildSessionRefGraph`'s shared-store branch keys its store-row → camera map
  (`videoToCam`) on the NATIVE store video ids (`loader.videoIdByCam`), not on
  the output header order.
- `_remapSharedStoreVideos(store, headerByNative)` (module-private) +
  `streamSessionIntoWriter`: when the native ids differ from the output header
  indices (a project `.slp` written by Python sleap-io, or a multi-session
  save where this session's videos sit at a global offset), the store's
  `framesData.video` column (and the video-keyed annotation/negative-frame
  keys) is remapped onto the header indices via a shallow wrapper — only the
  video column is copied; `appendStore`'s own `buildVideoIdMap` remap is a
  no-op for external-video files, so the remapped ids written ARE final
  (`videos: []` keeps that passthrough inert). Identity maps skip the copy.

**Video fallback for video-less reopened sessions.** `resolveVideoPath(cam,
views, videoFiles, lazyVid)` and the `buildSessionRefGraph` camera loop fall
back to the reopened file's own video record (`loader.videos`: filename +
shape) when no live video is attached (a lazily reopened session saved before
attaching videos), so the re-save round-trips the original video
filename/shape instead of degrading to `<camName>.mp4` with zero dimensions.
Covered by `tests/test-lazy-reopen.js`.
- **`finalizeProjectWriter(writer, opts)`** — `writer.close()`/`writeToSink()`.
- **`buildSessionSlpBytesStreaming(session, views, videoFiles, opts)`** — thin
  single-session wrapper chaining all four (unchanged call signature/behavior
  for existing callers/tests).

**Calibration-only cameras** (in `session.cameras` but with no loaded lazy
store — a calibration file defining more cameras than videos loaded) get a
header `Camera`+`Video` (0-frame) and a cameraGroup slot so the calibration
round-trips, but are skipped for `appendStore`. Loaded cameras carry their
GLOBAL `videoIndex`/`trackBase` (position in `ctx.allVideos`/`ctx.allTracks`,
not a per-session-local index) into `appendStore`'s offsets and the overlay's
video ref. **2D user corrections are overlaid:** any resident frameGroup
carrying a user instance in a camera is a corrected/added `(camera, frameIdx)`;
those camera-frames are materialized (grouped + unlinked union, via the shared
`_buildSioPoints` from `file-io.js`) and `appendFrames`d FIRST, so #208's
first-write-wins dedup shadows the store's original predicted row. Because
overlays occupy output frames `[ctx.runningOut, ctx.runningOut+E)` for THIS
session and each shadowed store row is skipped by `appendStore`, a grouped
frame's output index is recomputed in a per-camera `storeOutIndex` map
(overlays first, then each camera's non-skipped rows in camera/row order,
continuing the shared running counter), and `refFor` resolves an edited
camera-frame to its overlay (instance position by object identity, then
`track`) or otherwise to the shifted store row. Only edited camera-frames are
materialized (minimal at prediction scale); every other frame streams from the
columnar store. An overlaid frame's untouched predicted siblings are
re-materialized too (the store row is skipped wholesale); they carry the
instance-level score as a per-point score (the frameGroup keeps no per-point
scores) so SLEAP's GUI doesn't hide them — mirrors the eager `buildSlpLabels`
reproj export. **Scope:** predictions + full grouping (identities + 3D) + 2D
corrections.

**Imports.** `window.SleapIO` (streaming writer API); `_buildSioPoints`
(`import-export/file-io.js`). **Imported by.** `import-export/save-load.js`
(`buildSlpBytes`, `saveAllSessionsStreaming`, `commitSessionForMultiSessionSave`,
`finalizeMultiSessionSave`).

### import-export/save-load.js

**Purpose.** Project lifecycle — newProject, save paths (quickSave,
saveAs, saveProjectSlp, saveProject), load dispatcher
(`handleLoadProject`), session-frame serialization helpers, the
loading-overlay/status-text UI helpers.

**Key exports.**
- Project: `newProject(force)` (`force` skips the unsaved-changes confirm and
  is used by the 3D-import reset), `markDirty`, `clearDirty`, `quickSave`,
  `saveAs`, `saveProjectSlp`, `saveProject`, `handleLoadProject` (routes a
  large `.slp` — `shouldUseLazySlp` — to the memory-bounded
  `handleLoadProjectSlpLazy` in `loading/session-loader.js` instead of the
  eager parse, freeing any previously loaded project first).
- `buildSlpBytes` (internal) assembles the multi-session SLP. **When EVERY
  session in `state.sessions` has an open `lazyLoader`, it routes to the
  memory-bounded streaming path** — `buildSessionSlpBytesStreaming`
  (`import-export/slp-streaming-write.js`) for a single lazy session, or
  `saveAllSessionsStreaming(sessions)` (below) for multiple — instead of the
  eager `buildSlpLabelsAllViews` + `saveSlpToBytes` (which would re-OOM and
  silently drop every unvisited frame). A mixed project (any session without a
  `lazyLoader`, e.g. hand-labeled) still falls through to the eager path.
- **`saveAllSessionsStreaming(sessions)`** / **`beginMultiSessionSave()`** +
  **`commitSessionForMultiSessionSave(handle, session)`** +
  **`finalizeMultiSessionSave(handle, opts)`** — the multi-session
  generalization of the streaming writer (see `slp-streaming-write.js`'s
  two-pass split). `saveAllSessionsStreaming` is a convenience wrapper for the
  case where every session's Track All/Triangulate All has ALREADY run and all
  sessions are simultaneously resident (fine when their combined compute
  fits). The three-piece API exists so a caller can interleave PASS 1's
  per-session commit (`commitSessionForMultiSessionSave` — builds the ref
  graph, then evicts that session's `lazyLoader`/`frameGroups`/
  `instanceGroups`) with that session's OWN compute step, one session at a
  time — the only way to keep peak memory bounded when a single session's
  compute alone approaches the tab's ceiling (~3.7 GB measured for a
  108k-frame×3-camera prediction session; three such sessions can never be
  simultaneously computed). **No UI currently drives that interactive
  per-session flow** (open → Track All → Triangulate All → commit → evict →
  next session) — `reopenSessionLazyLoader(session, sourceFileEntries,
  wasSharedStore)` (internal) supports it via
  `SioLazyLoader.sourceFiles` (cheap retained `File` handles, so pass 2's
  restream doesn't need Track All/Triangulate All redone). For a shared-store
  project session (lazily reopened single-file project, where every camera's
  sourceFiles entry is the SAME `.slp`), it reopens via
  `SioLazyLoader.openProjectSlp` so the one interleaved store is read once and
  `_sharedStore`/`videoIdByCam` are restored — per-camera `open()` would
  re-read the whole project once per camera and pass 2 would then append the
  shared store N times (duplicating every frame/track).
  `commitSessionForMultiSessionSave` records the flag as `sharedStore` on
  `handle.pending`, and `finalizeMultiSessionSave` passes it through.

  **GC-timing finding (real cage5×3) — resolved.** Dereferencing a session's
  heavy state makes it *eligible* for GC but doesn't force reclamation —
  driving the real pipeline with `opts.sink` streaming and short yields alone
  still left memory climbing session over session and crashed at pass 2. The
  actual root cause turned out to be upstream: `pose/tracker.js`'s
  `trackAll()` called `loadAllLazyFrames()` (full ~108k-frame materialization)
  before tracking even started, though the cross-view tracker is genuinely
  sequential and never needed it — see `sweepTrackAllFrames` below, the fix.
  Combined with `opts.sink` streaming (avoids also materializing the whole
  output as one extra in-memory buffer) and `encourageGC(totalMB)` (allocates
  toward the real heap ceiling — a modest allocation is trivially satisfied
  from free space without forcing the mark-compact pass that reclaims a
  large, old-generation object graph — called between sessions and
  periodically within each windowed sweep, in `save-load.js`/`tracker.js`/
  `export-modals.js`), the real cage5×3 pipeline now completes without
  crashing, verified across three independent full runs. A worker-based
  redesign (each session's compute in a dedicated Worker, `terminate()`d
  between sessions) was investigated as a more structurally deterministic
  alternative and ruled out: `tracker.js` has a top-level DOM call that fires
  on import, `trackAll()`/`triangulateAllFrames()` are UI-entangled, and — a
  module Worker cannot import `lib/sleap-io/index.browser.js` at all in this
  environment (bare-specifier imports in `chunk-X76PRJK6.js` only resolve via
  the page's import map, which Workers don't inherit; `yaml` specifically is
  CDN-only, not vendored) — moot once the real fix (stop over-materializing)
  was found.

  Each session's
  `sessions_json` payload carries per-session `metadata.lucid.identities`
  (alongside `frameIdentityMap`/`tracks`), keeping identities scoped per
  session across save/load. The file-level `identities_json` remains a
  cross-session concatenation for SLEAP compatibility only. The file-level
  `allTracks` is a name-deduped union across sessions; after it is built,
  `buildSlpBytes` **re-points every instance's `track` to the canonical (first-
  seen) Track object for its name** so sleap-io's object-identity
  `tracks.indexOf(instance.track)` resolves it to the right global slot.
  Otherwise a later session's instance on a shared-name track (its own SIO.Track
  object was discarded by the dedup) serialized as `-1` (trackless), dropping the
  track. (On load, the global slot is re-localized to the session's own track
  index by name — see `slp-import.js` / `remapGlobalTrackToSession`.)
- Status / overlay: `showLoading(msg)`, `hideLoading`,
  `setStatus(text, type)`.

**Trackless (null track) preservation.** `_restoreProjectV2` restores grouped
and unlinked instances with `trackIdx = null` when the saved `trackIdx` is null
(it no longer defaults to `0`), so a trackless instance stays trackless across a
project save/reload — matching the SLP import path in `slp-import.js`.
- 3D-import guard: `confirmDiscardImported3D()` (two-button warning modal,
  Promise<boolean>) and `ensureNo3dImportBlockingLoad()` — called at the top of
  the session-load entry points (`handleLoadProject`, `handleLoadSlpFile`,
  `handleLoadSessionFolder`). When `state.has3dImportWithoutSession` is set
  (3D points imported into a skeleton-only project), it warns and, on confirm,
  fully resets via `newProject(true)` so nothing — not even the skeleton —
  survives before the session loads. `newProject` clears the flag.

**Imports from project modules.**
- `../pose/pose-data.js`, `../pose/triangulation.js`,
  `../loading/video.js`, `../demo-data.js`, `./file-io.js`,
  `../ui/app-state.js`, `../loading/session-loader.js`,
  `../loading/sio-lazy-loader.js` (`SioLazyLoader`, for
  `reopenSessionLazyLoader`), `./slp-streaming-write.js`,
  `../ui/rendering.js`, `../ui/info-panel.js`,
  `../pose/initialization.js`, `../ui/sessions-panes.js`,
  `./slp-import.js`.

**Imported by.** `pose/triangulation.js`, `pose/tracker.js`,
`pose/initialization.js`, `import-export/slp-import.js`,
`loading/session-loader.js`, `ui/info-panel.js`, `ui/rendering.js`,
`ui/identity-assignment.js`, `ui/export-modals.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** File menu New / Save / Save As / Quick Save /
Open Project, dirty-state tracking, the loading spinner overlay, and
the status bar at the bottom.

---

### import-export/slp-import.js

**Purpose.** SLP/H5 project import + 3D-points-overlay import. Three
workflows: load fresh SLP (replaces state), additive merge SLP into
current session, overlay reprojected points3d from H5.

The `.slp` parse is dispatched by the private `parseSlpForImport(file,
onProgress)`: real `.slp` files go through `parseSlpViaSleapIO` (sleap-io.js
streaming reader, PR 5.1), with `parseSlpH5` (raw h5wasm worker) kept for SLEAP
analysis `.h5` and as a fallback on any typed-read error. Both yield the same
`slpData`, so `reconstructInstanceGroupsFromDicts` + the rest of
`handleLoadSlpFile`/`handleAddSlp` are unchanged.

On load, identities are restored **per session**: each session prefers its
own `metadata.lucid.identities` (from `sessions_json`) and only falls back to
the file-level global `identities_json` for legacy/non-lucid SLPs. This keeps
IDs from leaking across sessions and keeps each session's `identity_idx`
references aligned with its own identity list.

**Tracks are likewise per-session.** Each session takes a fresh **copy** of its
track list — `metadata.lucid.tracks.slice()` when present, else
`slpData.tracks.slice()`. Without the copy, every session in a non-lucid SLP
shared the one `slpData.tracks` array (and the per-session maxTrack padding
mutated it), so deleting a track in one session hit all of them. (The `Session`
constructor also copies defensively — see `pose/pose-data.js`.)

**Global→per-session track-index remap (critical).** The worker reads each
instance's track column as an index into the file-level GLOBAL track union
(`slpData.tracks`). For a lucid multi-session project (`hasPerSessionTracks`),
pass-1 translates that global index to THIS session's track index by NAME via
`remapGlobalTrackToSession` (in `import-track-resolve.js`), and the `maxTrack`
padding is SKIPPED. Using the raw global index as a per-session index — plus the
padding — was the `global_0` → `track_3` corruption: deleting `global_0` in one
session reorders the saved global union, pushing another session's `global_0` to
a higher global index that then padded phantom `track_N` names on reload.
Verified by `verify/roundtrip-tracks-multisession-harness.html` (distinct names)
and `verify/ms-delete-track-roundtrip-harness.html` (real shared-name fixture,
delete → save → reload, comparing fixed vs. old loader).

**Trackless (null track) preservation.** A trackless instance is exported with
`track=null` (sleap-io writes it as `-1` in the SLP `instances` table — a valid
"no track" value that SLEAP GUI also supports). On re-import a null/`-1` track
stays trackless (`trackIdx = null`) for **both user and predicted** instances:
the raw-instance path uses `resolveImportTrackIdx`
(`import-export/import-track-resolve.js`), and the lucid grouped-reconstruction
path keeps `instMeta.trackIdx` null instead of defaulting to `0`. Defaulting to
`0` (the former predicted-instance behavior) snapped a deleted-track instance
onto the first track label (e.g. `global_0`) after an export/reload round-trip.

**Key exports.**
- `handleLoadSlpFile(slpFile)` — replace-current-state load. Drives the
  two-level LoadingProgressModal: all N session groups are pre-allocated
  up-front (from the pre-computed `slpAllSessionNames` list) BEFORE the
  per-session for-loop so the header reads "Session n of N" (the true
  total). Inside the loop each iteration just calls
  `setCurrentSession(slpSessionGroupIds[slpSessIdx])`. After the non-
  embedded folder-picker dialog resolves, re-engages
  `showLoading('Loading session N/M videos...')` so the blocking overlay
  stays up during the async per-video decode (without this, the rest of
  the UI was interactable while videos loaded). Skip-and-continue on
  per-session video-load failure (failed session is dropped from
  `state.sessions`).
- `restoreGroupingAndUnlink(session, slpData, slpSessIdx, opts)` — restores a
  session's LUCID project state from the SLP's `sessions_json`: identities,
  `InstanceGroup` grouping, per-instance `nulledNodes`/occlusion, and 3D points
  (via `reconstructInstanceGroupsFromSession`/`...FromDicts`), then moves every
  ungrouped instance to the unlinked pool and de-dups pass-1 leftovers. The
  `session` must already hold pass-1 raw instances in its `FrameGroups`.
  Extracted from `handleLoadSlpFile` so it and the **session-folder single-SLP
  loader** (`loading/session-loader.js#handleLoadSessionFolderSingleSlp`) share
  ONE implementation — that loader previously rebuilt the session flat (raw
  poses only) and silently dropped grouping, occlusion, and identities from the
  saved project `.slp`.
- Occlusion of **unlinked** user labels is restored on load by
  `nulledNodesFromOcclusion` (lives in `import-export/import-track-resolve.js` so
  it's unit-testable; see that module). Called in the pass-1 raw-instance build
  of BOTH `handleLoadSlpFile` and `handleLoadSessionFolderSingleSlp`.
- `handleAddSlp()` — additive merge into current session.
- `handleLoadPoints3dH5()` — overlay 3D points from H5. Requires only a loaded
  **skeleton** (not a full session): a camera-less skeleton-only project is
  accepted, the 3D viewport is force-created (bypassing the calibration gate)
  so the points render, and `state.has3dImportWithoutSession` is set so a later
  session load warns + resets (see `ensureNo3dImportBlockingLoad` in
  `save-load.js`). For a skeleton-only project there is no video to define a
  frame count, so it adopts the file's full duration (max `frame_indices` + 1)
  as `state.totalFrames`, calls `timeline.setTotalFrames`, and writes the
  `#totalFrames` counter DOM directly (it must NOT call `updateTotalFrames()`,
  which reads decoder sample counts and would reset the count to 0), making
  every frame navigable (otherwise only frame 0 would be reachable). The H5
  `track_names` / n-tracks dimension carries the identity/track assignment.
- `importSlpProjectWithProgress({ sessions, state, decoderFactory })` —
  testable entry point that loads a multi-session project through the
  progress modal. Sessions load SEQUENTIALLY; videos within a session load
  IN PARALLEL via the private `_loadSessionVideosParallel` helper. Skip-
  and-continue at the session level. Also attached to `window` / `globalThis`.
- `reconstructInstanceGroupsFromDicts(session, fgDicts, camKeyToName, nodeNames, opts)`
  — async; rebuilds one session's `InstanceGroup`s + member `Instance`s from its
  saved `frame_group_dicts` (lucid grouping metadata in `sessions_json`),
  removing the matching pass-1 raw-SLP duplicates and restoring `points3d`.
  Extracted from `handleLoadSlpFile` (which now calls it) so the SLP grouped-
  reconstruction path is headlessly round-trip testable — it preserves trackless
  (`trackIdx` null) and identity-less (`identity_idx` -1) instances rather than
  defaulting them to track/identity 0. `opts.onProgress(msg)` receives batch
  progress; `opts.batch` (default 20000) sets the yield interval. Returns
  `{ restoredGroups, restoredWith3d }`. Now used only for the raw-worker
  fallback path (files parsed by `parseSlpH5`).
- `reconstructInstanceGroupsFromSession(session, typedSession, rawSession, nodeNames, opts)`
  — async; the typed analog (PR 5.2) used for `.slp` files read via
  `parseSlpViaSleapIO`. Rebuilds `InstanceGroup`s from the typed
  `RecordingSession` (`frameGroups → instanceGroups → instanceByCamera`): 2D
  points/occlusion from each typed `Instance._xy`/`_visible`, per-instance
  metadata from `ig.metadata.lucid.instanceMeta`, 3D from `ig.instance3d.points`,
  and per-session identity from `ig.metadata.lucid.identityId` (falling back to
  the raw dict's `identity_idx` for legacy files). Reads both LUCID's legacy and
  the new canonical `sessions_json`. Same pass-1 dedup + trackless/identity-less
  handling as the dict version. Returns `{ restoredGroups, restoredWith3d }`.
- `parseSlpForImport(file, onProgress)` (private) — dispatches `.slp` →
  `parseSlpViaSleapIO`, else / on error → `parseSlpH5`.

**Private helpers (not exported).**
- `_loadSessionVideosParallel({ sessionIdx, session, state, modal, groupId, decoderFactory })`
  — fan-out per-video decoder loads via `Promise.allSettled`. Used by
  `importSlpProjectWithProgress` and the non-embedded path of
  `handleLoadSlpFile`.

**Project-load decoder pool reset.** At the top of `handleLoadSlpFile`,
closes every decoder in `state.decoderPool` and `state._decoderPoolCold`,
cancels every cold eviction timer, and re-initialises both arrays.

**Imports from project modules.**
- `../pose/pose-data.js`, `../pose/triangulation.js`, `./file-io.js`,
  `./slp-merge.js`, `../loading/video.js`, `../ui/app-state.js`,
  `../loading/session-loader.js`, `./save-load.js`,
  `../ui/rendering.js`, `../ui/info-panel.js`,
  `../pose/initialization.js`, `../ui/ui-wiring.js`,
  `../ui/sessions-panes.js`. Also spawns
  `../loading/frame-worker.js` (twice) via `new Worker(new URL(...))`.

**Imported by.** `import-export/save-load.js`, `ui/ui-wiring.js`.

**User-facing features.** File menu Load SLP, File menu Add SLP (merge),
File menu Load Points3D H5.

---

### import-export/import-track-resolve.js

**Purpose.** One pure (dependency-free) helper, `resolveImportTrackIdx(session,
rawTrackIdx, instType)`, that maps an imported instance's raw track index to
LUCID's internal representation. A trackless instance (`track = -1` or `null`)
stays trackless (`trackIdx = null`) for **both** user and predicted instances;
real track indices pass through. Defensively normalizes an unsigned-int32
readback of `-1` (`0xFFFFFFFF`) back to `-1`.

Extracted from `loading/session-loader.js` (which transitively imports `app.js`
and so can't be bridged into the test runner) specifically so it can be unit
tested. `session`/`instType` are retained in the signature but no longer
consulted. The former predicted-instance "coerce trackless → 0" behavior caused
a deleted-track instance to reappear on the first track (`global_0`) after an
export → reimport round trip.

Also exports `remapGlobalTrackToSession(rawTrackIdx, globalTrackNames,
sessionTrackNames)` — maps a per-instance track index from the file-level
(GLOBAL) track list to a SPECIFIC session's track index, **by name**. A
multi-session SLP stores ONE global track list (`tracks_json`) and writes each
instance's track column as an index into it, but tracks are per-session. Without
this remap, deleting a track in one session reorders the global union and
silently remaps another session's instances (the `global_0` → `track_3` bug).
Trackless stays trackless; a global track absent from the session returns `-1`.
`slp-import.js` calls it in pass-1 for lucid multi-session projects; the
save-side counterpart (re-pointing instances to canonical Track objects so they
serialize to the right global slot) lives in `save-load.js` `buildSlpBytes`.

Also exports `nulledNodesFromOcclusion(points, occluded, type)` — rebuilds a
**user** instance's occlusion set (`nulledNodes`) from its saved per-point
occlusion (a point present in the file but flagged not-visible).
`_buildSioPoints` writes an occluded node as real-xy + `visible:false`, so
occlusion lives in the SLP as invisibility for BOTH grouped and unlinked
instances — but the explicit `nulledNodes` FLAG is only persisted in per-group
`instanceMeta` (grouped only). An **unlinked** user label (e.g. a prediction
converted to a user label that was never grouped) therefore lost its occlusion
on reload; this derives it back, in the pass-1 raw-instance build of BOTH
`handleLoadSlpFile` and `handleLoadSessionFolderSingleSlp`. Predicted instances
are excluded (an invisible predicted point is low-confidence, not a user
occlusion). Lives here (dependency-free) so it's unit-testable —
`tests/test-occlusion-derive.js`.

**Key exports.** `resolveImportTrackIdx`, `remapGlobalTrackToSession`,
`nulledNodesFromOcclusion`.

**Imported by.** `loading/session-loader.js` (re-exports `resolveImportTrackIdx`;
the three import paths keep importing it from there),
`import-export/slp-import.js` (both functions). Bridged into
`tests/test-runner.html`; covered by `tests/test-import-track-resolve.js`.

---

### import-export/slp-merge.js

**Purpose.** Pure helpers for additive multi-SLP loading — skeleton
compatibility check, track merging, frame merging, group rebuild.

**Key exports.**
- `validateSkeletonCompatibility(existing, incoming)` — returns
  `{error, reorderMap}`.
- `mergeTracksIntoSession(session, incomingTracks)`.
- `mergeSlpFramesIntoSession(session, slpData, videoIdxToCameraName,
  cameras, trackRemap, nodeReorderMap)` — trackless instances (track=-1/null),
  user OR predicted, keep `trackIdx = null` (no longer coerce predictions to 0).
- `rebuildInstanceGroupsForFrames(session, frameIndices)` — groups by `trackIdx`;
  trackless instances of any type are skipped (not bucketed into track 0).

**Imports from project modules.**
- `../pose/pose-data.js` — `Skeleton`, `Camera`, `Instance`,
  `InstanceGroup`, `FrameGroup`, `Session`.

**Imported by.** `import-export/slp-import.js`.

**User-facing features.** Backs File menu Add SLP — merging an SLP into
an existing session without overwriting it.

---

## root

### app.js

**Purpose.** App entry. Two lines — imports `pose/initialization.js`,
which runs `init()` at module-load.

**Key exports.** None.

**Imports from project modules.**
- `./pose/initialization.js`.

**Imported by.** Nothing (entry point loaded via `<script type="module">`
in `index.html`).

**User-facing features.** App boot.

---

### demo-data.js

**Purpose.** Generate synthetic Session, Skeleton, and Cameras for
"Load Demo Session" — a 4-camera mouse rig with a 6-node skeleton and
a circling-mouse animation noised over 3 of 4 views (top view left
empty so the user can practice triangulating).

**Key exports.**
- `createDemoCalibration()` — returns 4 calibrated `Camera` objects
  (back / mid / side / top).
- `createDemoSkeleton()` — `Skeleton.defaultMouse()`.
- `generateDemoKeypoints3D(numFrames)` — 3D-keypoint trajectories.
- `createDemoSession(numFrames=100)` — returns
  `{session: Session, keypoints3d}`.

**Imports from project modules.**
- `./pose/pose-data.js` — `Skeleton`, `Camera`, `Instance`,
  `FrameGroup`, `Session`, `UnlinkedInstance`.

**Imported by.** `pose/initialization.js`,
`import-export/save-load.js`.

**User-facing features.** File menu Load Demo Session — the synthetic
test dataset shipped with the app.
