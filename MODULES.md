# LUCID Module Reference

In-depth reference for every ES module in the LUCID codebase. Use this to
locate which module owns a given concern before editing.

The codebase is split across four directories plus two root files:

- `pose/` — data model, triangulation/reprojection math, cross-view tracker.
- `ui/` — DOM-side controllers, overlays, panes, modals, viewport.
- `loading/` — video decoders, session-loader workflows, h5wasm workers.
- `import-export/` — file pickers, parsers, project save/load, SLP import.
- root — `app.js` entry point, `demo-data.js` synthetic dataset.

External script-tag globals (`three`, `mp4box`, `h5wasm`, `dockview-core`, and
`Mp4Muxer` — local copy in `lib/mp4-muxer/`, used for 3D-video `.mp4` muxing)
are not listed under "Imports from project modules".

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
- `addNewInstanceSmart()` — adds a new user instance to the focused view,
  copying topology from cached/predicted/cursor.
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
  `addEdge`, `removeEdge`, static `defaultMouse()`.
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
  frameGroups, instanceGroups. **Tracks and identities are per-session.** The
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
  dedicated "No ID" track is created), legacy migration (`migrateGlobalIdentitiesToPerFrame` —
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

**Node weights.** At the start of `matchFrameInstances`, the module resolves a
per-node weight array (`_nodeWeights`) from the session skeleton via
`getNodeWeightArray` (`ui/settings.js`, set in the Tracking Wizard). Every
per-node cost — `epipolarScore`, `reprojectionScore`, the 3D-distance signal in
`reorderGroupsByPrevTargets`, and each `computeInstanceDistance` call — scales a
node's contribution by its weight and skips weight-0 nodes, so a node set to 0 is
ignored by the tracker entirely. `null` weights ⇒ every node weighted 1
(behaviorally identical to before this feature).

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
  `getTrackingThreshold`.
- `../import-export/save-load.js` — `setStatus`, `showLoading`, `hideLoading`.
- `../ui/rendering.js` — `drawAllOverlays`.
- `../ui/info-panel.js` — `updateInfoPanel`.

**Imported by.** `ui/ui-wiring.js`.

**User-facing features.** "Track Frame" / "Track All" buttons, identity
propagation across frames, find-match-for-selected.

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
- Lazy H5 loader: class `LazyFrameLoader`, `shouldUseLazyH5(file)`,
  `ensureLazyFrameData`, `buildLazyFrameGroupSync`, `batchLoadLazyFrames`,
  `loadAllLazyFrames`, `evictLazyFrames`. Spawns
  `loading/slp-import-worker.js` (resolved against `document.baseURI` so
  sub-path deployments work — see ISSUES.md I-8) for HDF5 reads.
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
- `showSlpExportModal()` — single-camera SLP export modal (pick one camera per
  session, export to one file). **Retained but no longer wired to the File menu**
  — its old "Export SLEAP File" item was replaced by "Export SLEAP File Per
  Session" (`showSlpExportPerSessionModal`).
- `showSlpExportPerSessionModal()` — "Export SLEAP File Per Session": bulk export
  for the **open/active session only**. Lists every assigned-camera view in that
  session (camera, target directory, versioned output filename `<stem>_vN.slp`),
  with Include options — **Predicted Instances** (checkbox), **Reprojections**
  (checkbox) emitted as UserInstance/PredictedInstance via a toggle; user labels
  always included. On Export it prompts for a folder (`window.showDirectoryPicker`,
  handle cached on `state.exportDirHandle`) and writes one 2D `.slp` per camera
  into that camera's associated subdirectory (`state.cameraDirMap[cam] || cam`),
  via `exportSlpClientSide(...)`. Versioned names mean source `.slp` files are
  never overwritten. Falls back to flat `downloadBlob` downloads when the File
  System Access API is unavailable. Esc closes the modal.
- `showSlpExportByCamModal()` — "Export SLEAP File By Cam": camera×session grid.
  Each camera column exports across all its selected sessions into one SLEAP
  file; the modal **bulk-exports every included column at once** via
  **Download All**, which prompts for a destination folder
  (`window.showDirectoryPicker`, handle cached on `state.exportDirHandle`) and
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
  (`#slpByCamSkelWarning`) flags blocked columns. Download All shows per-file
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

**Key exports.**
- Tab control: `setupPanelTabs`.
- Tables: `populateVideosTable`, `populateCamerasTable`,
  `populateSkeletonTable`, `populateSessionAssignTable`,
  `populateUnassignedVideos`.
- Detail dialogs: `showVideoFileDetail`, `showCameraDetail`.
- Skeleton editor: `setupSkeletonEditing`, `parseSkeletonJSON`,
  `exportSkeletonJSON`.
- Per-frame data: `updateInfoPanel`, `updateFrameInfo`,
  `updateTriangulationBadge`.
- Session: `ensureSession`.

**Imports from project modules.**
- `../pose/pose-data.js` — `Skeleton`, `Camera`, `Session`.
- `../pose/triangulation.js` — `getInstanceGroupsForFrame`.
- `./overlays.js` — `REPROJECTION_COLOR`.
- `./rendering.js` — `drawAllOverlays`, `updateFrameCounters`.
- `./interaction.js` — `isInteractiveClickTarget`.
- `./app-state.js` — `state`, `timeline`, `interactionManager`.
- `../import-export/save-load.js` — `setStatus`, `markDirty`.
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
  `onMouseLeave`, `onKeyDown`, `_addNewInstance` (used by smart-add).
- `isInteractiveClickTarget(target)` — used by other UI to skip
  click-through on form controls.

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
  panel's gray on the skeleton.
- Geometry: `videoToCanvas`, `makeVideoToCanvasTransform`,
  `computeLabelOffset`, `getLineDashPattern`.
- Skeleton drawing: `drawSkeleton`, `drawReprojectedSkeleton`,
  `drawReprojectionErrors`, `drawSelectionHighlight`,
  `drawHoverHighlight`, `drawDragPreview`, `drawInstanceLabels`,
  `drawInstanceTypeIndicator`, `drawUnlinkedInstances`.
- Composite: `drawFrameOverlays(ctx, viewName, frameGroup,
  instanceGroups, session, options)` — the main per-view draw entrypoint.
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
- `drawAllOverlays(frameIdx)` — main per-frame redraw across every view.
- `updateFrameCounters()` — updates status-bar frame counters.

**Imports from project modules.**
- `./app-state.js` — `state`, `interactionManager`, `timeline`.
- `../pose/triangulation.js` — `ensureLazyFrameData`,
  `getInstanceGroupsForFrame`, `triangulateAndReproject`,
  `storeReprojectedInstances`.
- `./overlays.js` — `drawFrameOverlays`.
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
(name → weight in `[0,1]`, default `1`), the cross-view **tracking thresholds**
(`TRACKING_THRESHOLDS` catalog — Tier A scoring knobs + Tier B reprojection
gates), plus a comprehensive **catalog of every keyboard shortcut**
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
- `getTrackingThresholdDefs()` / `getTrackingThreshold(id)` /
  `getTrackingThresholds()` / `setTrackingThresholds(map)` — read/write the
  cross-view tracker's user-editable thresholds. `getTrackingThresholdDefs`
  returns the wizard's render catalog `[{ id, label, default, value, min, max,
  step, desc }]`; `getTrackingThresholds` returns the effective `{ id: value }`
  map the tracker snapshots per run. Values clamp to each threshold's range and
  entries equal to the default are dropped. Ids: `epipolarDecay`, `reprojSigma`,
  `epipolarWeight`, `reprojWeight`, `minMatchScore`, `prevIdentityBonus`,
  `reprojGate2`, `reprojGate3`, `reprojGate4`.
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
render a greyed, dashed reference chip), and **Tracking Wizard** (two sections:
**Node Weights** — one row per node of the active session's skeleton with a
number field, range `0–1`, step `0.01`, spinner arrows suppressed, seeded from
`getNodeWeight(name)`, with a hint when no skeleton is loaded; and **Tracking
Thresholds** — one labelled+described number field per `getTrackingThresholdDefs()`
entry, range/step from the catalog). All edits mutate a local `working` state
only (only editable bindings are tracked); nothing commits until **Apply**
(`setDefaultTriangulationMethod` + `applyBindings` + `setNodeWeights` +
`setTrackingThresholds`). Cancel / close `×` / backdrop click / Escape discard. A
capture-phase document keydown listener makes the modal fully capture the
keyboard (background shortcuts don't fire while it's open) and is removed on
teardown.

**Imports from project modules.** `./settings.js` (`getDefaultTriangulationMethod`,
`setDefaultTriangulationMethod`, `getActions`, `applyBindings`, `formatBinding`,
`getNodeWeight`, `setNodeWeights`, `getTrackingThresholdDefs`,
`setTrackingThresholds`); `./app-state.js` (`getActiveSession`).

**Imported by.** `ui/ui-wiring.js`.

**User-facing features.** Settings modal — choose default triangulation method,
remap keyboard shortcuts, set per-node tracking weights (Tracking Wizard, also
reachable via Tracks ▸ Tracking Wizard).

---

### ui/timeline.js

**Purpose.** SLEAP-like canvas timeline showing track occupancy bars,
frame markers, and current-frame indicator. Click-to-seek, drag-scrub,
shift-drag range select, pinch / Ctrl+wheel zoom, middle-click pan. Block 1 (Prompt 4)
adds tree-grouped per-camera labels, an inner scrollable track-area
wrapper, and an empty-camera placeholder row per camera without tracks.

**Trackpad / wheel semantics.** `_handleWheel` intercepts events where
`e.ctrlKey === true` for zoom (covers macOS trackpad pinch — browsers
translate pinch into `wheel` with `ctrlKey: true` — and explicit
Ctrl/Cmd+wheel). It also intercepts horizontal-dominant scroll
(`|deltaX| > |deltaY|`), panning `_scrollFrame` left/right (same axis as
middle/right-drag pan and the scrollbar thumb) and calling
`preventDefault()` only when the pan actually moved. Every other wheel
event (vertical-dominant two-finger scroll, plain mouse wheel) returns
without `preventDefault()`, so the event bubbles to `_trackScrollEl` and
its `overflow-y: auto` produces native vertical scrolling. macOS's overlay
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
- Group ops: `unlinkGroup`, `performGroupButtonAction` (shared by the toolbar
  Group button and the `Shift+G` shortcut — context-sensitive group/ungroup),
  `showGroupContextMenu`, `hideGroupContextMenu`.
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
  `handleLoadSessionFolderPerCamera`.
- Video assignment: `autoAssignVideosToCameras`, `forceVideoSelection`,
  `forceVideoSelectionWithFolder`, `matchSessionFolder`,
  `pickParentDirectoryForSessions`, `showParentDirMatchSummary`.
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

**Imports from project modules.**
- `../ui/app-state.js`, `../pose/pose-data.js`, `./video.js`,
  `../import-export/file-io.js`, `../pose/triangulation.js`,
  `../import-export/save-load.js`, `../ui/rendering.js`,
  `../ui/info-panel.js`, `../pose/initialization.js`,
  `../ui/sessions-panes.js`, `../ui/ui-wiring.js`.

**Imported by.** `pose/initialization.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `ui/info-panel.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**User-facing features.** File menu Load Calibration / Load Videos /
Load Session Folder / Load Multi-Session, all video-to-camera
auto-matching, session-folder mode chooser. `handleLoadSessionFolder` calls
`ensureNo3dImportBlockingLoad()` first, so loading a session over a
skeleton-only 3D-points import prompts before discarding it.

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

**Key exports.**
- `videoLog(msg, level)` — namespaced logger.
- `OnDemandVideoDecoder` — class. Selected methods: `init(source)`,
  `getFrame(frameIndex)`, `decodeRange(start, end)`, `playNative`,
  `pauseNative`, `seekNative`, `switchSource`, `close`,
  `drawCurrentFrame`.
- `EmbeddedVideoDecoder` — class for SLP-embedded frames. `getFrame`,
  `hasFrame`, `close`.
- `VideoController` — class. Selected methods: `seekToFrame`,
  `scrubToFrame`, `togglePlayback`, `startPlayback`, `stopPlayback`,
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
  `buildSlpLabelsMultiSession`, `serializeSkeleton`,
  `convertSlpToV06Compatible`. On 2D export both `buildSlpLabels` and
  `buildSlpLabelsMultiSession` keep each instance's own track — grouped
  AND ungrouped/unlinked — so a flat 2D project's tracks survive; an
  ungrouped instance only drops its track if a grouped instance already
  holds that track in the same frame (SLEAP forbids two instances sharing
  a (frame, track) pair). Reprojections still export trackless.
- SLP export (client-side): `exportSlpClientSide`,
  `exportSlpMultiSession`.
- `buildSlpLabelsAllViews` writes each session's identity list into that
  session's `metadata.lucid.identities` (in `session.identities` order, so
  `identity_idx` stays valid). The file-level `identities_json` dataset is a
  cross-session concatenation kept only for SLEAP/headless compatibility — it
  is NOT the per-session source of truth on reload (see slp-import.js).
- Skeleton validation: `findSkeletonMismatch(selections)` — returns `null` when
  all selected sessions share a skeleton (node count + names, in order),
  otherwise a human-readable mismatch message. Pure (no SleapIO); used both to
  guard `buildSlpLabelsMultiSession` and to pre-flight the per-camera download.
- SLP parse: `parseSlpH5(file, onProgress)` — spawns worker.
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

### import-export/save-load.js

**Purpose.** Project lifecycle — newProject, save paths (quickSave,
saveAs, saveProjectSlp, saveProject), load dispatcher
(`handleLoadProject`), session-frame serialization helpers, the
loading-overlay/status-text UI helpers.

**Key exports.**
- Project: `newProject(force)` (`force` skips the unsaved-changes confirm and
  is used by the 3D-import reset), `markDirty`, `clearDirty`, `quickSave`,
  `saveAs`, `saveProjectSlp`, `saveProject`, `handleLoadProject`.
- `buildSlpBytes` (internal) assembles the multi-session SLP. Each session's
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
  `{ restoredGroups, restoredWith3d }`. Exercised by
  `verify/roundtrip-null3d-harness.html`.

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

**Key exports.** `resolveImportTrackIdx`, `remapGlobalTrackToSession`.

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
