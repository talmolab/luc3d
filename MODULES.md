# LUCID Module Reference

In-depth reference for every ES module in the LUCID codebase. Use this to
locate which module owns a given concern before editing.

The codebase is split across four directories plus two root files:

- `pose/` — data model, triangulation/reprojection math, cross-view tracker.
- `ui/` — DOM-side controllers, overlays, panes, modals, viewport.
- `loading/` — video decoders, session-loader workflows, h5wasm workers.
- `import-export/` — file pickers, parsers, project save/load, SLP import.
- root — `app.js` entry point, `demo-data.js` synthetic dataset.

External CDN imports (`three`, `mp4box`, `h5wasm`, `dockview-core`) are not
listed under "Imports from project modules".

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
- `setupTimeline()` — instantiates `Timeline` and wires its frame-change /
  range-select callbacks plus the display-mode button group.
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
  methods `project`, `projectPoints`, `undistortPoint`.
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
  frameGroups, instanceGroups, identity-mapping tables. Many methods:
  identity assignment (`assignIdentityToGroup`, `propagateIdentity`,
  `setFrameIdentity`), group editing (`createGroupFromUnlinked`,
  `unlinkGroup`, `removeInstanceGroup`, `assignToGroup`), repair
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
- `../import-export/save-load.js` — `setStatus`, `showLoading`, `hideLoading`.
- `../ui/rendering.js` — `drawAllOverlays`.
- `../ui/info-panel.js` — `updateInfoPanel`.

**Imported by.** `ui/ui-wiring.js`.

**User-facing features.** "Track Frame" / "Track All" buttons, identity
propagation across frames, find-match-for-selected.

---

### pose/triangulation.js

**Purpose.** DLT triangulation, reprojection math, fundamental-matrix /
epipolar utilities, Hungarian assignment. Also hosts the lazy-H5 frame
loader and the user-facing triangulation orchestration (single-frame,
all-frames, multi-frame range).

**Key exports.**
- Math: `triangulatePointDLT`, `triangulatePoints`, `reprojectPoint`,
  `reprojectPoints`, `computeReprojectionError`,
  `computeReprojectionErrors`, `computeMeanReprojectionError`,
  `computeInstanceDistance`, `hungarianAlgorithm`, `cameraCenter`,
  `invert3x3`, `backProjectToRay`, `backProjectToRays`,
  `pointToRayDistance`, `pointsToRayDistances`,
  `computeFundamentalMatrix`, `epipolarError`, `epipolarErrorMatrix`.
- Group math: `triangulateAndReproject(instanceGroup, cameras, options)`,
  `storeReprojectedInstances(group, triangulationResult, allCameras)`.
- Lazy H5 loader: class `LazyFrameLoader`, `shouldUseLazyH5(file)`,
  `ensureLazyFrameData`, `buildLazyFrameGroupSync`, `batchLoadLazyFrames`,
  `loadAllLazyFrames`, `evictLazyFrames`. Spawns
  `loading/slp-import-worker.js` (resolved against `document.baseURI` so
  sub-path deployments work — see ISSUES.md I-8) for HDF5 reads.
- Frame access: `getInstanceGroupsForFrame`,
  `frameHasGroupedUserInstances`, `updateTimelineForFrame`.
- Orchestration: `triangulateMultiFrameInstances(start, end, onProgress)`,
  `reTriangulateGroup`, `triangulateCurrentFrame`,
  `triangulateAllFrames`, `sessionHasCalibration`,
  `showCalibrationRequiredPopup`.

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
Group-by-Identity, multi-frame triangulation, SLP per-session, SLP
all-sessions, JSON labels, points3d H5, reproj H5).

**Key exports.**
- `showGroupByTrackModal()` — modal that bulk-groups by trackIdx.
- `groupByIdentityAndTriangulateAll()` — bulk-group then triangulate.
- `showSlpExportModal()` — single-session SLP export modal.
- `showSlpExportAllModal()` — multi-session SLP export.
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
  `sessionHasCalibration`, `showCalibrationRequiredPopup`.
- `./rendering.js` — `drawAllOverlays`, `setReprojErrorVisible`.
- `./info-panel.js` — `updateInfoPanel`.
- `../import-export/save-load.js` — `showLoading`, `hideLoading`,
  `setStatus`.
- `../import-export/file-io.js` — `exportSlpClientSide`,
  `exportSlpMultiSession`, `buildPoints3dH5`, `buildReprojH5`.
- `../pose/initialization.js` — `update3DViewport`.

**Imported by.** `ui/ui-wiring.js`.

**User-facing features.** File menu Export (JSON / SLP / SLP All / H5
points3d / H5 reproj), Edit menu Group-by-Track / Group-by-Identity,
Multi-Frame Triangulate modal.

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
- Color: `TRACK_COLORS`, `REPROJECTION_COLOR`, `UNGROUPED_USER_COLOR`,
  `getTrackColor`, `getGroupColor`, `getInstanceColor`,
  `adjustColorBrightness`, `errorColor`, `hexToRgb`, `brightenColor`,
  `desaturateColor`, `complementaryColor`.
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
0.4 * window.innerHeight)`. The save/restore is **inlined** — it uses
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

### ui/timeline.js

**Purpose.** SLEAP-like canvas timeline showing track occupancy bars,
frame markers, and current-frame indicator. Click-to-seek, drag-scrub,
shift-drag range select, pinch / Ctrl+wheel zoom, middle-click pan. Block 1 (Prompt 4)
adds tree-grouped per-camera labels, an inner scrollable track-area
wrapper, and an empty-camera placeholder row per camera without tracks.

**Trackpad / wheel semantics.** `_handleWheel` only intercepts events
where `e.ctrlKey === true` — that single flag covers macOS trackpad
pinch (browsers translate pinch into `wheel` with `ctrlKey: true`) and
explicit Ctrl/Cmd+wheel on a regular mouse. Every other wheel event
(plain two-finger trackpad scroll, plain mouse wheel) returns without
`preventDefault()`, so the event bubbles to `_trackScrollEl` and its
`overflow-y: auto` produces native vertical scrolling. macOS's overlay
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
new rows visible.

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
sizing (capped at 40% of `window.innerHeight`), the toolbar-button
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

### ui/ui-wiring.js

**Purpose.** Top-level UI wiring. Builds the menu bar, transport controls,
keyboard handlers, visibility tab, view-mode (grid/single) switching,
playback rate, and re-exports popular helpers like `unlinkGroup`,
`showGroupContextMenu`, `seekToLabeledFrame`, `fitTimelineToData`.

**Key exports.**
- Menu / setup: `setupMenus`, `setupUI`.
- Group ops: `unlinkGroup`, `showGroupContextMenu`, `hideGroupContextMenu`.
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
`sessions-panes.js`.

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`,
`ui/layout-controls.js`, `loading/session-loader.js`,
`import-export/slp-import.js`.

**User-facing features.** Menu bar (File / Edit / View / Help), transport
controls (play/pause/seek/speed), keyboard shortcuts (Space, arrows,
T, A, etc.), grid/single view toggle, info-panel/3D/timeline visibility
toggles, "seek to next labeled frame".

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
- View/grid: `createViewForVideoFile`, `updateGridLayout`,
  `createVideoPromptCell`, `fitCanvasesToCells`, `cellResizeObserver`,
  `rebuildVideoController`, `updateTotalFrames`.
- Session-mode UI: `showSessionModeModal`, `showMissingFilesPopup`.
- Filesystem: `enumerateDirectoryHandle`.
- Misc: `resolveImportTrackIdx`.

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
auto-matching, session-folder mode chooser.

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
  `convertSlpToV06Compatible`.
- SLP export (client-side): `exportSlpClientSide`,
  `exportSlpMultiSession`.
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
- Project: `newProject`, `markDirty`, `clearDirty`, `quickSave`,
  `saveAs`, `saveProjectSlp`, `saveProject`, `handleLoadProject`.
- Status / overlay: `showLoading(msg)`, `hideLoading`,
  `setStatus(text, type)`.

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
- `handleLoadPoints3dH5()` — overlay 3D points from H5.
- `importSlpProjectWithProgress({ sessions, state, decoderFactory })` —
  testable entry point that loads a multi-session project through the
  progress modal. Sessions load SEQUENTIALLY; videos within a session load
  IN PARALLEL via the private `_loadSessionVideosParallel` helper. Skip-
  and-continue at the session level. Also attached to `window` / `globalThis`.

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

### import-export/slp-merge.js

**Purpose.** Pure helpers for additive multi-SLP loading — skeleton
compatibility check, track merging, frame merging, group rebuild.

**Key exports.**
- `validateSkeletonCompatibility(existing, incoming)` — returns
  `{error, reorderMap}`.
- `mergeTracksIntoSession(session, incomingTracks)`.
- `mergeSlpFramesIntoSession(session, slpData, videoIdxToCameraName,
  cameras, trackRemap, nodeReorderMap)`.
- `rebuildInstanceGroupsForFrames(session, frameIndices)`.

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
