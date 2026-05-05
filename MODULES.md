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
  `/loading/slp-import-worker.js` for HDF5 reads.
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

**User-facing features.** Video pane docking (drag/move/resize), view
strip (top), session strip (bottom), per-pane brightness/rotation
controls, switch-session UX, move-video-between-sessions modal.

---

### ui/timeline.js

**Purpose.** SLEAP-like canvas timeline showing track occupancy bars,
frame markers, and current-frame indicator. Click-to-seek, drag-scrub,
shift-drag range select, wheel zoom, middle-click pan.

**Key exports.**
- `Timeline` — class. Selected methods: `setData(session)`,
  `setCurrentFrame(frameIdx)`, `setTotalFrames(n)`, `setZoom(level)`,
  `scrollTo(frameIdx)`, `resize`, `redraw`, `destroy`,
  `setDisplayMode(mode)`, `refreshTracks(session)`,
  `setFrameModified(frameIdx, modified)`, `getPreferredHeight`.

**Imports from project modules.**
- `./overlays.js` — `getTrackColor`.

**Imported by.** `pose/initialization.js`.

**User-facing features.** Bottom timeline widget — seek, scrub, zoom,
range-select, modified-frame markers, per-track occupancy bars,
display mode toggle.

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
header for the full list. Notable ones: `app-state.js`, `pose-data.js`,
`triangulation.js`, `rendering.js`, `info-panel.js`, `save-load.js`,
`slp-import.js`, `file-io.js`, `session-loader.js`, `video.js`,
`tracker.js`, `initialization.js`, `identity-assignment.js`,
`export-modals.js`, `sessions-panes.js`.

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`,
`ui/layout-controls.js`, `loading/session-loader.js`,
`import-export/slp-import.js`.

**User-facing features.** Menu bar (File / Edit / View / Help), transport
controls (play/pause/seek/speed), keyboard shortcuts (Space, arrows,
T, A, etc.), grid/single view toggle, info-panel/3D/timeline visibility
toggles, "seek to next labeled frame".

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

**Imported by.** Spawned via `new Worker('/loading/slp-import-worker.js',
{type: 'module'})` from `import-export/file-io.js` (eager parse) and
`pose/triangulation.js` (lazy reads).

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
overlay-paired video panes.

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
- `handleLoadSlpFile(slpFile)` — replace-current-state load.
- `handleAddSlp()` — additive merge into current session.
- `handleLoadPoints3dH5()` — overlay 3D points from H5.

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
