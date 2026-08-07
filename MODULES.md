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

**`frameIdentityMap` packed keys (luc3d #185 follow-up #3).** `frameIdentityMap`
maps (frameIdx, camera, raw trackIdx) → identityId with **one entry per 2D
detection project-wide** — 2,627,447 of them on the real 180,210-frame ×
5-camera project, a measured **132 MB** of a renderer JS heap that is hard-capped
near 4 GB (the ceiling behind both the merged-save and project-reload failures).
Keys are therefore packed into a single exact-integer `Number`:
`frameIdx * 2^23 + camIdx * 2^17 + (trackIdx + 1)` — 30 bits of frame, 6 of
camera index, 17 of `trackIdx + 1` (so the `-1` untracked sentinel packs as 0),
53 total. Codec: `_fimPack`/`_fimUnpack`/`_fimIsPacked` (module-private) plus
`Session._fimKey`/`_fimDecode`/`_fimCamIdx`.

Every read/write goes through `Session` so the layout lives in one place:
`setFrameIdentity`, `getFrameIdentityValue`, `hasFrameIdentity`,
`deleteFrameIdentity`, and `frameIdentityEntries()` (a generator of decoded
`{frameIdx, camName, trackIdx, identityId, key}` records, for the consumers that
used to parse keys themselves — the ID timeline, `track-identity-ops`, the
propagate remap). **Do not index `frameIdentityMap` directly**; a raw
`"frame:cam:track"` string will simply miss.

Tuples that cannot be packed (trackIdx > 131070, or a camera absent from
`session.cameras`) fall back to the legacy string key so such a project keeps
working rather than silently losing identities; `_fimDecode` handles both forms.

**On-disk format is unchanged.** `exportFrameIdentityEntries()` emits the
original `[["frameIdx:camName:trackIdx", identityId], ...]`, and
`ingestFrameIdentityEntries()` accepts BOTH that and packed numbers — so every
already-saved project (including the real 1.4 GB one) still loads, and files
written now stay readable by older builds. Callers: the write side in
`save-load.js`, `file-io.js`, `slp-streaming-write.js`; the read side in
`save-load.js`, `slp-import.js`, `session-loader.js`. Guarded by the
`frameIdentityMap packed-key codec` block in `tests/test-identity.js` (round-trip,
-1 vs 0, cross-tuple collisions, unpackable fallback, dual-format ingest, export
shape, colon-containing camera names) and by `tests/e2e/save-golden-digest.mjs`
at the byte level.

One deliberate exception: `track-identity-ops.js` `deleteTrackAt` still writes the
legacy `"frame:cam:null"` STRING for entries on the deleted track. That is not
representable in the packed space and consumers have always skipped it
(`parseInt('null')` is `NaN`), so packing it would be a behaviour change rather
than a refactor.

**`points3d` flat typed arrays (luc3d #189, follow-up #2).**
`InstanceGroup.points3d` is a flat **`Float64Array(3 * nNodes)`** — node `k` at
`[3k, 3k+1, 3k+2]` — replacing the old array of boxed `[x,y,z]|null` rows. A
missing / un-triangulated node is an **all-NaN triple**, not a `null` row.

Why: 531,799 instance groups × 15 nodes = 7,976,985 keypoints on the real
180,210-frame project. Boxed, that measured **808 B per group (410 MB)** living
entirely in V8's pointer-compressed heap, which a Chrome renderer hard-caps near
4 GB. Flat, it is ~116 B per group in the cage (**59 MB**) plus a backing store
allocated OUTSIDE the cap (verified: 6,272 MB of `Float64Array` allocates fine
against a reported 4,192 MB `jsHeapSizeLimit` — `tests/e2e/_diag-cage-vs-external.mjs`).
Sizes measured in a real renderer by `tests/e2e/_diag-repr-sizing.mjs`.

**f64, not f32, is deliberate:** it costs the *same* in the cage (168 B/object
either way — only the external backing store doubles), and keeps every
coordinate bit-identical to the boxed representation. That is what lets
`tests/e2e/save-golden-digest.mjs` stay byte-for-byte unchanged across the
conversion, gating a change that touched ~105 call sites.

Codec (exported here, used everywhere): `makePoints3d`, `points3dNodeCount`,
`hasPoint3d`, `getPoint3d`, `readPoint3d` (allocation-free), `setPoint3d`,
`clearPoint3d`, `someValidPoint3d`, `countPoints3d`, `clonePoints3d`,
`toBoxedPoints3d`, `fromBoxedPoints3d`, `asPoints3d` (dual-format ingest —
passes a `Float64Array` through UNCOPIED, converts boxed rows).
**Do not index `points3d` directly**; `pts[k]` is now a coordinate, not a point.

Collapsing `null` into NaN loses no information: the SLP format has always
written NaN for missing 3D keypoints, so a save/reload round-trip already erased
the distinction. `null` is still accepted on the way in (`fromBoxedPoints3d`,
`setPoint3d`) and still emitted at the boundaries that need the legacy shape —
the JSON project format (`save-load.js`) and the `points3d.h5` export
(`file-io.js`) both go through `toBoxedPoints3d`.

**`observedPoints` is derived, not stored (luc3d #189).**
`InstanceGroup.observedPoints` — the 2D points paired with the group's
reprojections, `{cameraName: Instance.points}` — is a **getter over
`instances`**, not an own property. Nine sites used to rebuild exactly that
object right after triangulating, and two more hand-patched it on member
add/remove "to keep observedPoints in sync"; the getter does that sync by
construction. As stored objects it was 531,799 of them on the real project, a
measured **74 MB** of the ~4 GB cage.

There is **no setter**: a stray `group.observedPoints = ...` throws a TypeError
in the app (ES modules are always strict) and is silently discarded in the
classic-script test harness — either way it cannot reinstate a stored copy that
drifts from `instances`, which was a real bug class (see
`tests/test-edit-group-fixes.js`).

It **allocates a fresh object per access** — hoist it into a local before reading
per-camera in a loop (`slp-import.js`, `save-load.js` do); the per-frame overlay
draw goes straight to `group.getInstance(view).points` instead.

`purgeTriangulationDataForGroup` no longer nulls it: every consumer gates on
`points3d && reprojections`, which the purge still clears. The JSON project
format still WRITES it for backward compat, but ignores it on restore.

**`Instance` flat coordinate storage (luc3d #189 follow-up #1).** `Instance`
holds 2D keypoints in a flat **`Float64Array(2 * nNodes)`** (`_xy`, node `k` at
`[2k, 2k+1]`, **NaN x = no point**) and occlusion in a **bit set** (`_occ`: a
plain Number at <=32 nodes, else a `Uint32Array`).

The real workload holds **2,630,632** Instances (5 cameras x ~526k) over
39,459,480 keypoints. Measured in a live renderer by
`tests/e2e/_diag-instance-size.mjs`: **824 B/instance of cage before, 172 B after
(240 B moves to an external backing store, outside the cap) — 2,067 MB -> 432 MB,
freeing 1,636 MB.**

**`points` and `occluded` are DELETED, not kept as getters.** Two of the three
ways this refactor could break are silent: `inst.points.length` meant *nNodes* at
~30 sites and would have doubled on a `Float64Array(2n)`, and `inst.occluded[k]`
against a Number bitmask yields `undefined` (falsy), which would have dropped
occlusion from every export with no error. Removing the fields turns both into an
immediate `TypeError`.

Accessors: `numNodes`, `hasPoint`, `getX`/`getY`, `getPoint` (allocates),
`readPoint(k, out)` (allocation-free), `setPoint`, `setPointFrom`, `clearPoint`,
`isOccluded`, `setOccluded`, `anyOccluded`, `countPoints`, `hasAnyPoint`,
`hasAnyUsablePoint`, `toPointsArray`/`toOccludedArray` (serialization),
`setPointsFrom`/`setOccludedFrom`, `adoptPointsFrom` (deliberate buffer sharing,
for lazy-2D hydration), `insertNodeAt`/`removeNodeAt` (skeleton edits — these
resize any backup alongside, so `restorePoints()` stays node-aligned),
`backupPoints`/`restorePoints`/`hasBackup`.

**The constructor is unchanged** — it still takes boxed `[[x,y]|null, ...]` (or a
`Float64Array`, adopted by reference) and normalizes, so all 23 construction
sites were untouched. Only readers changed.

f64 rather than f32 is deliberate: identical cage cost, and bit-exact values keep
`tests/e2e/save-golden-digest.mjs` byte-for-byte unchanged across the conversion.

One behavior change, unavoidable in the representation: a boxed row could
previously hold `[NaN, NaN]` and count as *present*; NaN-x now means absent. No
producer emits such a row (every construction site writes `null`).

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
  (`user`/`predicted`/`reprojected`), `score`, `occluded[]`, `nulledNodes`,
  and `identityId` (null unless this is a TRACKLESS UNLINKED instance whose
  disbanded group's identity was retained on it by `unlinkGroup` — luc3d
  #201; consumed/cleared when the instance joins a group; not persisted).
  Methods `toggleOccluded`, `setPointVisible`, `backupPoints`, `restorePoints`.
- `UnlinkedInstance` — wrapper around an `Instance` not yet placed in an
  `InstanceGroup`. Auto-incrementing `id`.
- `FrameGroup` — per-frame container of linked `instances` and
  `unlinkedInstances`, both keyed by camera name.
- `Identity` — id + name + color (uses `IDENTITY_COLORS` palette).
- `IDENTITY_COLORS` — 20-color palette for identity badges.
- `InstanceGroup` — cross-view grouped instances + triangulated `points3d`
  + cached `reprojectedInstances`. `markDirty`/`markClean`. Also
  `triangulationMethod` (`'ba'`|`'dlt'`|undefined), recording WHICH SOLVER
  produced `points3d`. Read by `resolveTriangulationMethod`,
  `ui/rendering.js`'s lazy reprojection fill, `adoptPrior3d` and the Info Panel's
  method label — and **persisted**, in per-group
  `metadata.lucid.triangulationMethod` (written only when `'ba'`; absent means
  DLT), because it cannot be reconstructed from `points_3d`. Before that,
  reopening a BA project gave every group BA 3D with an *unknown* method, so the
  display fill re-derived reprojections with DLT and the panel reported DLT's
  error under a "DLT" label for BA points (measured on the regression fixture:
  1.62 px shown instead of 1.43 px). Guarded by
  `tests/e2e/triangulate-all-ba-file-roundtrip.mjs`.
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
  `clearTrackIdentity`; `propagateIdentity` — stamps an identity from a start
  frame FORWARD, and is **project-wide on a lazy session**: a resident pass over
  `frameGroups` (authoritative — it sees in-memory edits and unlinked instances)
  followed by a `lazyLoader.forEachInstanceRow` pass over the columnar store for
  every frame the first pass could not see. It previously walked `frameGroups`
  alone, so on a reopened project "propagate forward" stopped at the edge of the
  resident window — nothing corrupted, since `frameIdentityMap` writes are
  durable, but almost nothing done. The store pass accumulates each frame's track
  set in one reused `Set` flushed on the frame boundary (that helper visits each
  (camera, frame) once, rows contiguous), so it is O(1) in memory rather than a
  180k-entry map of Sets; the per-frame uniqueness/collider rule is shared by both
  passes via `_applyIdentityAtFrame`. NOTE `assignTrackToIdentity` above is still
  resident-only — it has **no callers** (dead since #155) and is left alone
  deliberately. `propagateIdentity` is now the FALLBACK for a manual identity
  switch, used only when there is no identity to swap away from — see
  `swapIdentitiesForward` next;
  `swapIdentitiesForward(startFrame, identityA, identityB)` — **exchanges two
  identities from `startFrame` through the END of the project, in every view**
  (luc3d #172). This, not `propagateIdentity`, is what a MANUAL identity
  correction means, and it is the identity-layer analogue of SLEAP's
  `Labels.track_swap` over `(frame_idx, None)`. `propagateIdentity` cannot
  express it: it follows ONE raw `(camera, trackIdx)` pair forward, so it dies at
  the first fragment boundary of that raw track — and real per-camera tracker
  output fragments constantly (the same animal is track 4 for a few hundred
  frames, then 12, then 20), which is why a correction reached only the current
  tracklet, and only the views the group happened to be visible in on that one
  frame (#172: "only a small fragment of the ID propagates down the timeline",
  "the propagation appears limited to tracks visible in the current view").
  Identity, unlike a raw track, is DENSE project-wide — that is why
  `frameIdentityMap` is per-frame keyed at all — so expressing the correction over
  identity VALUES needs no track continuity. Rewrites both durable structures:
  `frameIdentityMap` (values only, so mutating during iteration is safe; packed
  keys carry `frameIdx` in their top bits, so the frame filter is arithmetic with
  no decode and no allocation on the 2.6M-entry real project) and the
  whole-project `instanceGroups[*].identityId` (saved into the columnar
  `instance_groups` table, used as the display fallback, and read directly by
  `propagateIdentitiesToTracks` step 2b — leaving it stale would let a later
  IDs→Tracks resurrect the pre-swap assignment). Frames before `startFrame` are
  never touched (#155), and the operation is an involution, so a later correction
  at frame G composes to "until the next manual correction" without tracking
  correction history. No frame materialization, so nothing hydrates or evicts.
  Returns `{entries, groups, frames}`. Guarded by the `swapIdentitiesForward
  (#172)` block in `tests/test-identity.js` and end to end by
  `tests/e2e/identity-switch-propagates-to-end.mjs`;
  `swapIdentitiesForwardInCamera(startFrame, cameraName, identityA, identityB)` —
  the **single-view** counterpart (luc3d #201). Same dense value swap, forward to
  the end of the project, but restricted to ONE camera: this is how an ID is
  corrected in one view (ungroup → switch the ID on that view's Ungrouped row →
  regroup), where the per-camera tracker crossed two animals in one camera and the
  other views are already right. Not `propagateIdentity`, even though that is
  already per-camera — it follows one raw track and dies at the first fragment
  boundary, which is exactly the #172 truncation. Differs from
  `swapIdentitiesForward` in one substantive way: it deliberately does NOT rewrite
  `instanceGroups[*].identityId`, since that is a single field shared by every
  view and writing it would leak the correction into the other cameras (`groups`
  in the result is therefore always 0, kept only so the shape matches for
  `describeIdentitySwitch`). Both the frame and camera filters are arithmetic on
  the packed key. Guarded by `tests/test-ungroup-retains-identity.mjs` (incl. a
  fragmented-raw-track case) and end to end by
  `tests/e2e/ungroup-retains-identity.mjs`), group assignment
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
  **Per-row resolution of ambiguous raw tracks (luc3d #203).** Step 2 skips
  `frameIdentityMap`'s explicit `-1` "ambiguous" entries (written by
  `commitTrackedFrame` when one camera's raw tracker briefly gives two animals the
  same `trackIdx`, "most common on the first frame or two"). But
  `oldKeyToNewTrackIdx` is also what step 4 remaps the COLUMNAR STORE through, and
  an absent key there means *no track* — so those instances kept the right track in
  memory (step 3's `instanceToIdentity` fallback) and went **trackless in the
  store**, permanently: trackless on export, a hole at the start of the Tracks
  Timeline, and store-derived `trackOccupancy` disagreeing with resident
  `frameGroups` for exactly the first frames. Step 2b now also builds
  **`rowClaim`**, keyed `(frame, camera, offsetInFrame)` from each group member's
  `_rawInstIndex`, which the step-4 callback consults FIRST — so each store row is
  resolved by its own group's identity even when two animals share one raw
  `trackIdx` on that frame (the callback's new `offsetInFrame` argument is what
  makes this possible; see `loading/sio-lazy-loader.js`). A per-track `rawClaim`
  fallback covers a member with no `_rawInstIndex`, and refuses to guess when two
  identities contest one key — those are counted and returned as
  **`ambiguousRawKeys`** (also `console.warn`ed and surfaced by
  `ui/ui-wiring.js`'s status line) rather than dropped silently. The return value
  is now `{tracks, instances, lazyErrorRows, ambiguousRawKeys}`. Guarded by the
  `propagateIdentitiesToTracks run twice (luc3d #203)` block in
  `tests/test-lazy-reopen.js`, which also pins the whole-operation invariant:
  after every run, the Timeline's `maxTrackIdx + 1` must equal
  `session.tracks.length`, checked per source so a failure names the culprit.
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
  `remapInstance` (steps 3/3b) consults when the raw per-camera
  `getIdentityIdForTrack` lookup has no usable answer. Regression test:
  `tests/e2e/first-frame-track-identity-collision.mjs` (builds a synthetic
  raw-trackIdx collision on frame 0 only, propagates, and asserts both
  Timeline display modes cover frame 0 identically to frame 1 — confirmed it
  fails pre-fix with `[null, null]` on the colliding camera's frame-0
  instances and passes post-fix).
  **Precedence (duplicate-ID-after-single-view-switch regression):** those
  group-derived repairs are FALLBACKS, not overrides — `remapInstance` and
  step 2b's per-member claims (`rowClaim`/`rawClaim`/the `newFrameMap`
  supplement) resolve each instance's identity from `frameIdentityMap` FIRST
  and consult `group.identityId` only for entries the map cannot answer
  (absent, or the `-1` collision sentinel). That matches every display
  consumer (`getGroupColor` is map-first) and matters because a single-view
  ID switch (`swapIdentitiesForwardInCamera`, luc3d #201) rewrites ONLY the
  map, deliberately leaving the cross-view `group.identityId` alone — the
  earlier group-first order resurrected the stale group identity on the
  still-grouped animal while the switched instance followed the map, landing
  the SAME ID/track on both animals on the switch frame (in memory and in the
  columnar store). `remapInstance` is also explicitly once-per-instance now
  (a `remapped` Set): an object shared by the step-3 `frameGroups` walk and
  the step-3b `instanceGroups` walk must not be remapped twice, since the
  second pass would look its already-rewritten `trackIdx` up in the old map
  and undo the first. Regression tests: the `single-view ID switch
  (duplicate-ID regression)` block in `tests/test-pose-data.js` (in-memory,
  store-remap callback, and a pin that the `-1`-collision group fallback
  still works).
  Separately, the auto-generated track-name fallback changed from `'id_' +
  ident.id` to the app's normal `'track_' + index` convention (a genuinely
  custom identity name like "Alice" is still preserved verbatim; only a
  placeholder name matching the `getOrCreateIdentityForTrack` pattern
  `id_<n>` is treated as "no real name" and replaced) — otherwise a
  Tracks→IDs→Tracks round trip renamed `track_0`/`track_1` to `id_0`/`id_1`
  instead of restoring the original naming. Legacy migration (`migrateGlobalIdentitiesToPerFrame` —
  converts a pre-per-frame project's global map to per-frame entries on load),
  group editing (`createGroupFromUnlinked` — when no identity is passed it
  prefers an identity the members ALREADY read as (the first member with one,
  via `getIdentityIdForUnlinkedInstance`, so a trackless member's retained
  instance-level identity counts too), and only then derives one from the
  first member's track, and only if that member HAS a
  track: grouping identity-less trackless instances yields a group with NO
  identity (-1), not
  a fabricated "id_null". Preferring the held identity is what lets an
  ungroup → re-assign one row → regroup round trip keep the animal's ID instead
  of renaming it to `id_<rawTrackIdx>` (luc3d #201). Grouping CONSUMES the
  members' instance-level retained identity (`Instance.identityId` reset to
  null — the group owns it from there; `assignToGroup` does the same);
  `unlinkGroup` — **retains identity** for each member before the group object
  (and with it the `group.identityId` fallback every identity reader relies on)
  is dropped (`_retainIdentityOnUnlink`): a TRACKED member gets the disbanding
  group's `identityId` stamped into `frameIdentityMap`; a TRACKLESS member gets
  it stamped on the instance itself (`Instance.identityId`) — the map is keyed
  by raw trackIdx, so a null track keys one shared per-camera slot that cannot
  name an individual, which is why the map-only retention silently skipped
  trackless members and the bug RECURRED for untracked predictions / manual
  annotations (the report against PR #202). Without retention, ungrouping
  reset every Ungrouped row's ID to "—" and discarded the
  assignment, making "swap the ID in one view" destructive (luc3d #201). The
  map stamp only
  fills in what the tracker path (`commitTrackedFrame`) already writes, and is
  conservative: it never overwrites an existing positive entry (that entry is
  what readers already prefer over `group.identityId`), and skips a raw-trackIdx
  key still shared with another group in the frame (the ambiguous-`-1` collision
  case — claiming it would mis-color the group still holding it). The instance
  stamp OVERWRITES: while grouped, `group.identityId` is the freshest truth for
  a trackless member (switches pin the group field and cannot write the map for
  a null track), so an older instance-level value is stale by definition;
  `getIdentityIdForUnlinkedInstance(cam, instance, frameIdx)` — THE resolver
  for an UNLINKED instance's identity: the per-frame map entry when the
  instance has a track (= `getIdentityIdForTrack`), the instance-level
  retained identity when it does not. Used by the info panel's Ungrouped rows,
  `getInstanceColor`, and the regroup derivation;
  `assignIdentityToUnlinkedTrackless(frameIdx, camName, instance, identityId)`
  — the one-view ID correction for a TRACKLESS unlinked row. Per-frame by
  nature (no track = no linkage to carry the correction to other frames);
  within the frame it hands the vacated identity to the trackless unlinked row
  in the same camera that already held the target, keeping the view
  duplicate-free (mirrors the tracked swap semantics). Routed to by
  `applyIdentitySwitch` when the unlinked row's instance is trackless. All
  trackless retention is guarded by `tests/test-ungroup-retains-identity.mjs`
  and end to end (save → lazy reopen → ungroup → one-view switch → regroup) by
  `tests/e2e/ungroup-trackless-reopen.mjs`;
  `removeInstanceGroup`, `assignToGroup`), repair
  (`deduplicateFrameIdentities`, `scrubOrphanInstances`,
  `_promoteIfMixed`), skeleton propagation
  (`propagateNodeAdded`/`propagateNodeRemoved`), camera-rename
  (`renameCameraInAllData`).
  **`videoContrast`** / **`videoBrightness`** / **`videoRotation`** (issue #149
  and follow-ups) — three `{ cameraName: int }` maps: contrast in [−100, 100],
  brightness percentage in [0, 200], rotation degrees in [−179, 180]. All
  **per-session** and persisted in the `.slp` (`metadata.lucid.videoContrast` /
  `videoBrightness` / `videoRotation`): `state.views` is rebuilt from scratch on
  every session switch, so a per-view field would silently reset — which is
  exactly what brightness used to do when it lived on `view._brightness`.
  Contrast and brightness are display-only (CSS filters on the view canvas);
  rotation is not — the renderer and hit-testing read `view.rotation`, which
  `restoreViewRotation` re-seeds from here at pane build. Default entries (0 /
  100 / 0) are never stored — see `ui/video-filters.js`, which owns every
  read/write, and `import-export/visibility-metadata.js` for the `.slp` mapping.
  The timeline's `_hiddenCameras` / `_hiddenTracks` / `_hiddenIdentities` Sets
  are session-scoped and persisted the same way (see
  `ui/timeline-visibility.js`).
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

**Animal-count auto-detect is a resident SAMPLE, deliberately.**
`computeMaxInstancesPerView` (used when the user has not set a count) reads
`session.frameGroups`, so on a lazy project it samples the resident window rather
than the project. It is NOT converted to a store sweep like the other
resident-only defects: every animal is visible in most frames, so the max is hit
almost immediately, and Track All is confirmed working on the real 180,210-frame
project with this behaviour — changing how the animal count is derived would
change tracking output on a path that currently works. The error is one-directional
(too LOW, only if no sampled frame shows every animal at once) and surfaces as a
too-small identity pool, so it now logs a warning naming the sample size and
pointing at the explicit setting instead of inferring silently.

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

**WHICH function the "Triangulate All" button calls.** `ui/ui-wiring.js:2146`
routes the toolbar split-button by method AND by session state: `'ba'` →
`triangulateAllFrames('ba')`; default/DLT with **any identities present** →
`groupByIdentityAndTriangulateAll` (`ui/export-modals.js`); DLT with no
identities → `triangulateAllFrames('dlt')`. Any real tracked project takes the
MIDDLE branch, so `triangulateAllFrames` is NOT the function a user exercises —
a distinction that cost five green end-to-end verifications of the wrong code
path while the reported bug sat in the other one. Diagnostics must drive
`groupByIdentityAndTriangulateAll` (see
`tests/e2e/_diag-real-playback-overlays.mjs`).

**It must never delete a frame's groups it cannot rebuild (the "Triangulate All
deleted my 3D" bug).** `groupByIdentityAndTriangulateAll` calls
`session.instanceGroups.delete(frameIdx)` and then rebuilds only those identity
buckets resolving on >= 2 cameras via
`getIdentityIdForTrack(cam, inst.trackIdx, frameIdx)`. On a reopened project that
lookup can return null for every instance — identity is carried on
`group.identityId`, and the per-frame track→identity entries do not necessarily
key by the `trackIdx` rehydrated instances come back with — so each frame was
emptied and nothing was put back. Measured on the real 180,210-frame project:
groups **3 → 0** on every probe frame, the whole operation finishing in 50 s
instead of 135 s because deleting was all it did. It now (a) seeds the buckets
from the existing groups' `identityId` when the per-frame lookup yields nothing,
and (b) returns early WITHOUT touching the frame when nothing would be rebuilt,
warning instead. Verified on the real project: groups 3 → 3, reprojGroups 3 → 3.
It also guards `fg === undefined` (the sweep's contract) — without it the first
3D-only frame throws mid-sweep, after the deletes have already run on an
arbitrary prefix of the project.

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
would silently track only the visited frames. **Fresh-open guard fix:**
`trackAll`'s upfront "any frames?" check used to read `session.frameIndices.length`
(== resident `frameGroups.size`) *before* the windowed-vs-full branch above ever
ran — so a freshly-opened large lazy project (zero frames visited/scrubbed yet,
which is every large project the first time Track All is clicked) always had
`frameIndices.length === 0` and immediately bailed with "No frames to track",
even though `session.lazyLoader.nFrames` correctly reported the whole project.
Found via a real end-to-end run against a 180k-frame×5-camera project. Fixed by
computing `loader`/`windowed` first and checking `loader.nFrames > 0` instead of
`frameIndices.length` when a windowed loader is present. Regression test:
`tests/e2e/track-all-fresh-lazy-session.mjs` (reopens a real saved lazy project
with 0 resident frameGroups and asserts Track All finds identities instead of
bailing). Hyperparameters come from the
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

**3D points are flat (luc3d #189).** The array-level entry points speak the
`Float64Array(3N)` `points3d` representation (see `pose/pose-data.js`):
`triangulatePoints` and `triangulatePointsBA` **return** one, and
`reprojectPoints`, `reprojectPointsCamera`, `pointsToRayDistances` and
`triangulateAndReproject` (via `result.points3d`) **consume** one. The
*per-point* helpers — `triangulatePointDLT`, `triangulatePointBA`,
`reprojectPoint`, `reprojectPointCamera`, `pointToRayDistance` — still take and
return boxed `[x,y,z]` / `[x,y]` triples; those are transient scratch values, not
storage, and keeping them boxed kept the conversion to the array boundary. Use
`readPoint3d(pts, k, buf)` to feed them without allocating per node.

Reprojection *outputs* stay boxed `[x,y]|null` per node: they are per-frame and
measured at ~0 MB, so there was nothing to win by converting them. **That "~0 MB"
holds PER FRAME only** — see the windowed Triangulate All note below, which must
not retain them project-wide.

**THE bulk-sweep primitive: `sweepLazyFrameWindows` (luc3d #195).** Exported from
this module and used by EVERY operation that must touch every frame. Hydrate a
2,000-frame window (`batchLoadLazyFrames`) → run the callback → drop the window's
non-user `frameGroups` (pinning the on-screen frame and any user-edited frame) →
`releaseWindow` → force a real collection every 5 windows. `opts.start`/`opts.end`
restrict it to a range. It replaced three byte-identical copies
(`sweepTrackAllFrames` in `pose/tracker.js`, the private `sweepTriangulationFrames`
in `ui/export-modals.js`, and the windowing inlined in `sweepTriangulateAllFrames`);
those now delegate to it, and their local `frameGroupHasUserInstances`/
`encourageGC` copies are gone.

**Which frames it visits (`_hasFrameData`) — a hydrated `FrameGroup` OR an
`instanceGroups` entry, never `FrameGroup` alone.** `onFrame(frameIdx, fg)`
therefore receives `fg === undefined` for a frame that has 3D grouping but no
resident 2D, and a callback that dereferences it must guard (`exportLabels` does;
the triangulation callbacks read `instanceGroups` and do not care). This is
load-bearing: the consolidation above originally gated on
`session.frameGroups.get(fi)` alone, which none of the three lifted copies did —
`sweepTriangulateAllFrames` called `ensureGroupsFromIdentities(session, fi)` for
every index in the window unconditionally. That **regressed luc3d #194**: every
frame whose 2D did not come back on hydration was skipped, while Triangulate All
had already wiped `reprojections` project-wide up front, so reprojections
disappeared everywhere and 3D was refreshed only where the sweep ran — the
original #194 symptom, one layer down. The e2e harness is structurally blind to
it (its fixture gives every frame 2D in every camera, so the two conditions
coincide); `tests/test-sweep-frame-coverage.mjs` pulls them apart and pins the
union rule for both the windowed and eager branches. It was confirmed to fail on
the pre-fix code (6 of 12 assertions, including the pure 3D-only case visiting
**zero** frames).

Rule of thumb: a `for (... of session.frameGroups)` loop in a BULK operation is a
bug. That map holds only RESIDENT frames — 31 of 180,210 on the real reopened
project — so such a loop silently processes ~nothing and returns a plausible count.
The opposite mistake is `loadAllLazyFrames` + iterate, which materializes 2D for
every frame × camera at once and OOMs the renderer. `sweepLazyFrameWindows` is the
shape that is neither.

**IMPORTANT — mutations do not survive the sweep.** After each window, non-user
frames are dropped and rebuilt from the columnar store on next hydration, so
mutating a PREDICTED instance's fields inside `onFrame` is lost. Durable edits must
land in the store's own columns (see `SioLazyLoader.remapTracksFromIdentity`),
in `frameIdentityMap`, or in `instanceGroups` — or must mark the instance
user-edited so its frame is pinned. This is why the track-swap fixes
(`ui/identity-assignment.js`, luc3d #195) write the store rather than sweeping.

**A store write must be mirrored into `instanceGroups`, not just `frameGroups`
(luc3d #195).** The two in-memory maps have different lifetimes: `frameGroups`
holds only the resident window (what the canvas reads), while `instanceGroups` is
rebuilt PROJECT-WIDE at reopen by `reconstructInstanceGroupsFromSessionLazy`, and
its members are lightweight placeholders whose `trackIdx` was copied from the
store at reconstruction time and is never refreshed on hydration. Group-level
operations read that copy rather than the store — `track-identity-ops.js`
`deleteTrackAt` decides which groups to DISSOLVE from it — so a store rewrite that
updates only the resident frames leaves the rest of the project claiming the old
track, and the next track delete dissolves the wrong groups. `swapTracks` and
`swapAssignTrack` therefore pair each `swapTracksInStore` with a
`swapTracksInMemory` pass over BOTH maps, sharing one `seen` set: the two maps
share instance objects for hydrated frames, and swapping such an instance twice
silently restores its original value — a self-cancelling no-op that reads as "the
operation never ran".

**Triangulate All is windowed on a lazy project (luc3d #194).**
`triangulateAllFrames` dispatches on the same `windowed` capability check
`trackAll` uses (`lazyLoader.isSync && typeof releaseWindow === 'function'`). With
a windowing loader it runs `sweepTriangulateAllFrames`: hydrate a 2,000-frame
window (`batchLoadLazyFrames`) → triangulate its groups → drop the window's
`session.frameGroups` entries (keeping the on-screen frame and any user-edited
frame) → `loader.releaseWindow` → `_encourageGC` every 5 windows. Mirrors
`sweepTrackAllFrames` in `pose/tracker.js`.

Before this, the sweep never hydrated lazy 2D at all. A reopened project's group
members are null-filled placeholder `Instance`s, so `hasAnyUsablePoint()` was
false and almost everything was skipped: measured **31 frames / 93 groups of
180,210 / 531,799** (0.02%) in 61 s on the real project, after which
`setReprojErrorVisible(true)` left the other 99.98% rendering blank reprojection
columns. Windowed: **180,210 frames / 531,799 groups, 0 skipped, 105 s.**
`loadAllLazyFrames` is deliberately NOT used — materializing 2D for 180,210
frames × 5 cameras at once is the OOM the memory work exists to prevent.

The windowed path stores only `points3d` (flat `Float64Array`, the file's own
representation) plus `usedCameras`; it does **not** set `group.reprojections` and
does **not** accumulate `state.triangulationResults`. Retaining reprojections for
531,799 groups is ~1.9 GB of boxed `[x,y]` pairs — larger than every allocation
#185/#189/#190/#191/#193 removed. Both are derived and are recomputed on demand
for the displayed frame by `drawAllOverlays` (`ui/rendering.js`), which runs after
`ensureLazyFrameData` has hydrated that frame's real 2D. Stale derived state is
cleared up front; `points3d` is deliberately *not* wiped up front but replaced
per group as the sweep reaches it, so the peak matches a global wipe while an
interrupted sweep never leaves groups with no 3D. The eager (small-project) path
keeps its previous behavior, including retaining reprojections.
`_triangulateGroupStep` holds the camera-name fixup + `>=2`-usable-view gate +
triangulate/store shared by both paths so they cannot drift; `_fgHasUserInstances`
and `_encourageGC` are local mirrors of `pose/tracker.js`'s privates (**keep in
sync** — `tracker.js` already imports from this module, so a two-way import was
avoided).

**Triangulation methods.** `'dlt'` (default) is the fast linear DLT.
`'ba'` initializes from DLT then runs a per-point Levenberg–Marquardt refinement
of the geometric reprojection error. Cameras are fixed (calibrated), so each
keypoint is refined independently — this mirrors aniposelib's
`CameraGroup.optim_points`, which is what sleap-anipose actually runs for pose
triangulation (aniposelib's `bundle_adjust_iter`, the one that also moves the
cameras, is its *calibration* path). Costs 4.6–6.1x DLT: ~310 µs per keypoint
versus ~54 µs, on a 5-camera / 15-node rig.

**`'ba'` is guaranteed never worse than DLT on the reported error (issue #113).**
Three properties make that true, and all three were wrong before:

1. *Residual space.* Residuals are formed in the camera's **native (distorted)**
   pixel space — where the detections live, where the noise is i.i.d., and the
   space `meanError` is reported in. `distortJacobian` supplies the analytic
   Brown–Conrady derivative and `projectAndJacobianCamera` chain-rules it onto
   the projection Jacobian. Previously the objective used *undistorted*
   observations and an ideal pinhole projection, so BA minimized one thing while
   the UI displayed another; with radial distortion the displayed error rose on
   up to 89% of points (2 cameras, k1=-0.3).
2. *Robust loss.* Soft-L1 (pseudo-Huber) via IRLS in the normal equations, at
   aniposelib's default scale (`BA_ROBUST_SCALE_PX` = 15 px, its
   `reproj_error_threshold`). `robustScale: Infinity` restores plain squares.
3. *Metric-matching polish.* A second LM phase minimizes Σ‖r‖, which **is** the
   reported mean error up to the 1/nViews factor, so monotonicity in the
   displayed number follows from the LM being monotone in its own loss. Seeded
   from whichever of {DLT, phase 1} already scores better. Not decorative:
   native-space soft-L1 alone still regressed ~20–47% of clean-noise trials,
   because minimizing Σ‖r‖² and minimizing Σ‖r‖ genuinely disagree. Disable with
   `polish: false`. A backtracking `guard` (on by default) is the belt-and-braces
   net for what phase 2 cannot cover.

Consequences worth knowing: the L1-type objective is ~10% less efficient than L2
on genuinely clean Gaussian noise (3D error 0.2101 → 0.2309) but 11–18x better
under a gross outlier (3.46 → 0.30), which is the right trade for real
detections. `meanErrorUndistorted` is deliberately **not** guarded — DLT is
inherently favored in ideal-pinhole coordinates since that is where its algebraic
objective lives, and guarding both was measured to veto real improvements. Views
**excluded** from the solve still count toward the headline `meanError`, so BA
fitting the included views better can raise it; that is correct (chasing an
excluded view is what excluding it forbids) and the invariant is pinned over the
solve's own views instead. `{ robustScale: Infinity, polish: false, guard: false }`
reproduces the pre-#113 behavior, which `tests/test-triangulation-ba.js` uses as
a baseline so the suite cannot silently stop testing the bug. The
Levenberg–Marquardt ladder itself was **not** the bug and was not changed — it
was verified strictly monotone in its own objective and converged to the local
optimum (0/3000 and 0/4000 respectively).

**No joint bundle adjustment: cameras are NEVER refined (deliberate scope).**
Everything the `'ba'` method does holds the cameras FIXED, so it is non-linear
triangulation however it is labelled in the UI. A true joint camera+structure
solve (`bundleAdjustCameras`, a port of aniposelib's
`CameraGroup.bundle_adjust_iter` — what `slap-calibrate` runs) was implemented
here and has been **DELETED**, along with its private support cast and its eight
tests. LUCID CONSUMES a calibration; it is not a calibration tool, and that
belongs where calibration is produced (sleap-anipose, on a checkerboard). Do not
re-add it. Three reasons, spelled out at the "Point refinement" header in
`pose/triangulation.js` so the next person finds them:

- The calibration is an **input the user is entitled to trust**. Mutating
  extrinsics mid-annotation means yesterday's 3D is not today's, and every
  already-triangulated frame becomes inconsistent with the new rig unless the
  whole project is re-solved.
- Metric **scale is unobservable** from images alone — a uniform similarity of
  cameras plus structure reprojects identically. aniposelib escapes this only via
  its rigid-board `errors_obj` term (weighted 2/board_square_length); animal
  keypoints have no equivalent reference. The deleted implementation had to pin
  camera 0 and renormalize the camera-0-to-1 baseline after every accepted step
  purely to keep the normal equations from being rank-deficient by 7 DoF, and it
  still could not fix a scale error (measured: a rig 8% too large reprojected at
  the 0.473 px noise floor before BA and came out unchanged).
- Reprojection error would stop being a **diagnostic**. It is the signal a user
  reads to spot a bad label or a bad calibration; if the solver may move the
  cameras, low error no longer distinguishes good labels from cameras bent to fit
  bad ones.

Naming note: the user-facing "Bundle Adjustment" label and
`triangulationMethodLabel` are unchanged — that is the term anipose/SLEAP users
expect for `optim_points` — but it does not imply camera refinement.

The method is selected via `options.method` on `triangulateAndReproject` and
threaded through the orchestration functions; the chosen method is recorded on
each group (`group.triangulationMethod`) and in each `state.triangulationResults`
entry (`.method`) so the info panel can label it.

**`options.method`'s default is SILENT — and that was a live footgun.** Omitting
it does not mean "keep whatever method this group already used"; it means DLT.
The governing rule now is **exported 3D == displayed 3D**: no path may replace a
bundle-adjusted solve with a DLT one behind the user's back. Three helpers
implement it, all in this module:

- `resolveTriangulationMethod(group)` → `'ba'|'dlt'`. The group's own recorded
  method wins; otherwise the user's global **Settings ▸ Triangulation Method**
  (`getDefaultTriangulationMethod`). Never a bare `'dlt'` literal. Used by
  `reTriangulateGroup`, both grouping sweeps in `ui/export-modals.js`,
  `ui/sessions-panes.js`'s move-view re-triangulate, `ui/ui-wiring.js`'s
  environment-skeleton solve, and `ui/identity-assignment.js`'s two group-writing
  loops. **Deliberately NOT used by `ui/rendering.js`'s lazy reprojection fill:**
  that path re-derives reprojections for 3D it does not own and does not write
  back, so it must REPRODUCE the recorded solve exactly rather than fall back to a
  global default. Rule of thumb — *writes* `points3d` → `resolveTriangulationMethod`;
  only *reads* it → match `triangulationMethod` exactly.
- `findEquivalentPriorGroup(priorGroups, group)` → the prior group with identical
  membership (camera for camera, by `Instance` object identity), or null.
- `adoptPrior3d(group, prior, method)` → copies `points3d`,
  `triangulationMethod` and `usedCameras`; returns true when `group` therefore
  needs no solve. Adoption requires identical membership **AND**
  `prior.triangulationMethod === method`, so it only ever fires when re-solving
  would be a provable no-op (an *unknown* prior method never matches). Does **not**
  copy `reprojections` — leaving those empty is what lets `ui/rendering.js`'s fill
  regenerate them (and `state.triangulationResults`) with the adopted method;
  copying them would suppress that fill and leave the Info Panel with nothing.

**The selected method GOVERNS the two grouping sweeps.** With Settings ▸ Default
Triangulation set to Bundle Adjustment, "Group by Track / Group by ID &
Triangulate All" leave BA 3D on *every* group — new, changed, or
unchanged-but-previously-DLT. That last case is why `adoptPrior3d` takes a
`method`: adopting on membership alone would keep the old DLT solution for exactly
the groups a user is most likely to already have, making the setting a silent
no-op. An explicit pick beats the default —
`groupByIdentityAndTriangulateAll(explicitMethod)` takes one, and
"Triangulate All ▸ DLT" (which routes there) passes `'dlt'`, so an explicit DLT
request is not overridden by a BA default. Consequence to be aware of: with DLT
selected, a grouping op over BA 3D *does* re-solve it as DLT — that is the setting
being obeyed, and unlike the old behavior it is named in the progress text and
status line rather than silent.

Two bugs this closes, both measured on `tests/e2e/fixtures/ba-rig-fixture.js`
(where BA's and DLT's 3D differ by 0.098 world units):

1. **Display** (`ui/rendering.js`'s lazy fill, which did not pass a method): the
   group kept BA's `points3d` and `triangulationMethod = 'ba'`, but the DLT
   re-solve's error landed in `state.triangulationResults` — so the panel labelled
   the number "Bundle Adjustment" and showed DLT's value (1.6155 px displayed vs
   BA's actual 1.4273 px). Guarded by
   `tests/e2e/triangulate-all-ba-display.mjs`.
2. **Data** (the grouping sweeps): `groupByIdentityAndTriangulateAll` and
   `groupByTrackAndTriangulateAll` delete a frame's `instanceGroups` and rebuild
   fresh objects around the same `Instance`s, then re-solved every group with the
   default method and stamped `triangulationMethod = 'dlt'`. Running either after
   a BA Triangulate All silently downgraded the whole project's 3D to DLT, and
   since save/export read `group.points3d`, the exported file stopped matching
   what the user had computed. Verified pre-fix: the exporter emitted DLT's 3D
   *exactly* (delta 0 from DLT, 0.098 from BA). Guarded by
   `tests/e2e/triangulate-all-ba-export.mjs`.

Regrouping does not invalidate a solve whose 2D inputs are unchanged, only one
whose membership changed — so the sweeps now ADOPT rather than re-solve in the
common case, which makes the correct behavior *cheaper* than the old one rather
than paying BA's ~3x-6x cost per group project-wide. Both sweeps report 3D
provenance ("N kept existing 3D, N solved via Bundle Adjustment, N via DLT") in
their progress text and status line, so a method's cost is visible rather than
hidden. The one deliberate DLT caller is the O(n×m) Hungarian cost matrix in
`ui/identity-assignment.js`, whose temporary groups' 3D is discarded and where only
the relative ordering of errors matters. It passes `{ method: 'dlt' }` **explicitly**,
so the invariant is the checkable one — *every* call site states its method — rather
than the uncheckable "every caller that forgot happened to want DLT".
`tests/test-triangulation-method-propagation.mjs` enforces that by scanning the app
source: it fails, naming file and line, on any call that omits the options object,
omits `method`, hardcodes `'dlt'` outside the cost matrix, or passes something that
is neither a resolver nor a threaded-in method (confirmed to catch the original
`ui/rendering.js` bug). A runtime assert inside `triangulateAndReproject` was
considered and REJECTED: it runs once per candidate PAIR inside that cost matrix, so
a warning would fire O(n*m) times per auto-assign — noise in a legitimate path,
which is exactly what the guard must not create.

**Distortion handling.** 2D keypoints on disk are lens-distorted. **DLT** runs in
ideal pinhole space: observations are undistorted first (`Camera.undistortPoint`),
which is required — DLT is linear only in those coordinates. **BA does not**; it
refines against the raw native-space detections (issue #113, above), so
`triangulateAndReproject` keeps `allObservationsRaw` index-parallel to the
undistorted set and masks the two identically whenever the outlier-rejection loop
drops a view. Reprojections meant for display or error comparison
must be **re-distorted** back to native pixel space
(`reprojectPointCamera` / `reprojectPointsCamera` → project, then
`Camera.distortPoint`). Comparing ideal reprojections against raw distorted
keypoints previously produced spurious error that grew toward the frame edges
("fisheyed coordinates", issue #85) and could drive cross-view identity
switches. The temporal-identity cost in `ui/identity-assignment.js` likewise
projects 3D targets with distortion before measuring distance to raw detections.

`triangulateAndReproject` reports the reprojection error in **both** spaces:
`meanError`/`errors` (distorted — what is drawn and broken down per view/node)
and `meanErrorUndistorted`/`errorsUndistorted` (ideal pinhole — a diagnostic; as
of #113 the distorted space is the one BA minimizes). The info panel shows the
distorted value as the headline
("N.NN px", colour-coded) with the undistorted value as a small subtitle below
it ("undist N.NN px"); the per-view and per-node breakdowns remain
distorted-space. Both error spaces are recomputed on project load — `.slp`
projects in `slp-import.js` and JSON/v2/v3 projects in `save-load.js`
(`_restoreProjectV2`) — mirroring this dual computation so the undistorted
subtitle is populated for loaded projects, not just freshly triangulated ones.

**Key exports.**
- BA math: `triangulatePointBA(observations, projMatrices, initial?, options?)`
  (`options`: `cameras` → native-space residuals and `observations` are then the
  RAW detections; `robustScale` px, default `BA_ROBUST_SCALE_PX`; `polish`;
  `guard`; `maxIterations`; `tol`),
  `triangulatePointsBA(allObservations, projMatrices, initialPoints?, options?)`
  (forwards `options` verbatim), `BA_ROBUST_SCALE_PX` (= 15),
  `triangulationMethodLabel(method)` → `'DLT'` | `'Bundle Adjustment'`.
  Module-private: `distortJacobian(camera, ideal)` → 2x2 Brown–Conrady
  derivative, `projectAndJacobianCamera(point, camera)` → native-space
  projection + 2x3 Jacobian.
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
  (`options.method` = `'dlt'`|`'ba'`, `options.triangulateOnly`,
  `options.robustScale` (BA soft-L1 scale in px), `options.includedCameras`,
  `options.reprojErrorThreshold`; returns
  `.method`, `.meanError`/`.errors` distorted-space and
  `.meanErrorUndistorted`/`.errorsUndistorted` ideal-pinhole-space),
  `storeReprojectedInstances(group, triangulationResult, allCameras)`.
  **`storeReprojectedInstances` eagerly builds a full `Instance` (+ its own
  `occluded` array) per camera per group — a real memory cost when called for
  the WHOLE project.** `triangulateAllFrames` and `triangulateMultiFrameInstances`
  (both whole/large-range bulk sweeps) no longer call it — they still set
  `group.reprojections`/`.points3d` (needed by `buildReprojH5` and the display
  fallback below), just not the heavier `reprojectedInstances` Map. Single-frame
  paths (`triangulateCurrentFrame`, `reTriangulateGroup`) and the identity-based
  bulk path (`groupByIdentityAndTriangulateAll`, `ui/export-modals.js` — already
  only stores `.points3d` via `triangulateOnly`, was never part of this cost)
  are unaffected. `getOrComputeReprojectedInstance(group, camName)` — the
  read-side companion: returns the cached `reprojectedInstances` entry if
  present, else synthesizes an equivalent `Instance` on demand from
  `group.reprojections[camName]` (never mutates/caches onto the group). Every
  consumer that used to call `group.getReprojectedInstance` directly now goes
  through this instead: `import-export/file-io.js`'s three export sites,
  `pose/initialization.js`'s double-click-to-promote and
  `onClonePredictedGroup`, `ui/interaction.js`'s click hit-testing and
  `_convertToUserInstance`. `ui/rendering.js`'s `drawAllOverlays` already had
  its own independent, coarser-grained lazy-fill (computes AND permanently
  caches `reprojectedInstances`/`.reprojections`/`state.triangulationResults`
  for whatever frame is currently being viewed) — unchanged, still the reason
  scrubbing to any frame shows correct reprojections regardless of which sweep
  triangulated it. `ui/overlays.js`'s 2D-display code already had its own
  fallback straight to `.reprojections[viewName]` (via `drawReprojectedSkeleton`,
  no Instance wrapper needed) — also unchanged. Covered by
  `tests/test-reprojection-lifecycle.js`'s "getOrComputeReprojectedInstance" block.
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
  **`finalizeLazyFrameGroup` fresh-Track-All duplicate-render fix.** This
  function (splits a freshly-(re)materialized lazy FrameGroup's raw
  instances into "already grouped" vs "unlinked", using `_rawInstIndex` to
  match a raw instance to an existing group's member) used to gate its
  "does this frame already have groups?" check on `session._lazyReopened` —
  a flag set ONLY by `handleLoadProjectSlpLazy` (reopening a saved project),
  never by a fresh Track All run in the current session. A fresh Track-All
  sweep evicts every frame except the current one from `session.frameGroups`
  (`sweepTrackAllFrames`'s windowed release) but never evicts
  `session.instanceGroups` — so scrubbing to any other frame afterward
  re-materialized it here, always took the "no groups" branch (since
  `_lazyReopened` was never true), and dumped every instance into the
  unlinked pool even though `session.instanceGroups` already had real groups
  for that exact frame — rendering each tracked animal TWICE: once via its
  still-resident InstanceGroup, once again as a freshly-unlinked duplicate.
  Only the current frame (kept resident throughout Track All, never
  evicted/rebuilt) was unaffected — matching the report exactly ("frame 1 is
  correct... all other frames have duplicate ungrouped instances"). Fixed by
  checking `session.instanceGroups` directly instead of gating on
  `_lazyReopened` — the existing `_rawInstIndex`-keyed hydration logic
  already works for both a reopened project's lightweight members and a
  fresh Track-All group's real members (both get `_rawInstIndex` tagged by
  whichever materialization site created them, per the tagging note above).
  Also verified the reverse direction still works: ungrouping an instance
  (`Session.unlinkGroup`) correctly makes it reappear in the unlinked pool
  (not missing, not still shown as linked) on the next re-materialization —
  the same hydration logic naturally handles "not claimed by any remaining
  group → unlinked." Regression test:
  `tests/e2e/lazy-frame-rematerialize-duplicate.mjs` (mirrors
  `commitTrackedFrame`'s real grouping across several frames, evicts all but
  the current one exactly like the windowed sweep, re-materializes one, and
  asserts no duplication; then ungroups one animal and confirms it correctly
  reappears unlinked while the other stays linked with no duplicate —
  confirmed all 4 assertions fail pre-fix and pass post-fix).
- Frame access: `getInstanceGroupsForFrame`,
  `frameHasGroupedUserInstances`, `updateTimelineForFrame`.
- Method preservation ("exported 3D == displayed 3D", see the BA section above):
  `resolveTriangulationMethod(group)` — the group's own method, else the user's
  Settings default, never a bare `'dlt'`;
  `findEquivalentPriorGroup(priorGroups, group)` — the prior group with identical
  membership by `Instance` object identity;
  `adoptPrior3d(group, prior)` — take the prior's `points3d` /
  `triangulationMethod` / `usedCameras` instead of re-solving (not
  `reprojections`, deliberately). The latter two exist for the regrouping sweeps,
  which rebuild `InstanceGroup` objects around unchanged `Instance`s.
- Orchestration: `triangulateMultiFrameInstances(start, end, onProgress, method)`,
  `reTriangulateGroup` (preserves the group's existing method via
  `resolveTriangulationMethod`),
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
- `../ui/settings.js` — `isCameraTracked`, `getTrackingThreshold`,
  `getDefaultTriangulationMethod` (the fallback in `resolveTriangulationMethod`).
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

### ui/custom-delete-ops.js

**Purpose.** Pure, DOM-free logic behind "Custom Instance Delete…" — LUCID's
equivalent of SLEAP's `sleap/gui/dialogs/delete.py` `DeleteDialog`
(Labels ▸ Custom Instance Delete…), adapted to the multi-view model. Imports **no
project modules** (only calls methods on the `Session` it is handed), so it bridges
into `tests/test-runner.html` for isolated unit testing — same contract as
`ui/track-identity-ops.js`. The DOM modal lives in `ui/ui-wiring.js`.

**Exports.** `collectDeletionTargets(session, filters, ctx)` (pure — returns
`{targets, count, byCamera, groupsDissolved, groupsUngrouped, instancesPromoted,
groupsLosing3d}`), `previewCascade(targets)`, `executeDeletion(session, targets)`,
`pruneOrphanIdentities(session, frameIndices)`.

**Vocabulary.** SLEAP's *video* scope is LUCID's **session** — every camera in a
session shares one frame index space, so a camera is a VIEW FILTER, not a frame
domain. The UI says **Grouped / Ungrouped** (the panel headers) and must never say
"Unlinked": in SLEAP an *unlinked prediction* is one with no `from_predicted`
back-link to a user instance, an unrelated concept that shares the word.

**Type and grouping are ORTHOGONAL axes**, not siblings — a grouped instance is
still user or predicted. "Delete grouped instances" is `type:'all'` +
`grouping:'grouped'`. Conflating them is the main way this dialog could become
incoherent. `type:'all'` = user + predicted (matching SLEAP's "all instances"),
never reprojections — those are derived and live in `reprojectedInstances`.

**Lazy / not-yet-hydrated frames.** Scope enumeration must never loop
`session.frameGroups` — that is the small resident window (31 of 180,210 frames
measured on the real project), so a bulk delete driven from it would silently delete
almost nothing while reporting success (the #185/#194/#195 bug class). So:
- `frameScope:'currentSession'` is **store-driven** via
  `lazyLoader.forEachInstanceRow`. It needs no hydration and no `async`, because all
  four filter axes resolve without materializing a frame: **type/track** from the
  store's own columns (`forEachInstanceRow`'s 4th `info` argument), **identity** from
  `frameIdentityMap` (in memory project-wide), and **grouping** from
  `session.instanceGroups` (also project-wide — rebuilt in full at reopen — whose
  members carry `_rawInstIndex`).
- `frameScope:'currentFrame'` normally reads the richer resident model, but falls
  back to the same store-driven collector restricted to that one frame when the
  frame has **no `FrameGroup`** (never hydrated). Otherwise its ungrouped rows,
  which exist only in the store, would be missed — a sneaky partial failure, since
  `instanceGroups` is project-wide so grouped members *would* still be found.
- A non-resident row has no `UnlinkedInstance` wrapper; `executeDeletion` counts it
  and skips the pool update. That is correct — the store row was the only thing that
  existed for it, and the frame hydrates from the compacted store.
- With no `lazyLoader` at all, session scope walks `frameGroups` ∪ `instanceGroups`;
  an eager project is fully resident, so that enumeration is complete by definition.

**Identity is resolved PER FRAME** via `session.getIdentityIdForTrack(cam,
trackIdx, frameIdx)`, never `group.identityId` (only refreshed on the frame an
identity was assigned — the #155/#168 staleness class). This is the same call
`groupByIdentityAndTriangulateAll` buckets by, so the dialog and the grouping
cannot disagree.

**Cascade, and why the dialog reports it.** A group must have ≥2 members, so
removing members can dissolve a group (`removeInstanceGroup`), auto-ungroup it
(`unlinkGroup`, returning the lone survivor to the ungrouped pool and **promoting a
predicted survivor of a formerly-mixed group to `type:'user', modified:true`**), or
leave it intact with stale 3D. `previewCascade` predicts all of this before any
mutation so the modal can warn — reporting only "N instances" hides two
irreversible side effects.

**`executeDeletion` order is load-bearing** (see `scratch/PLAN-custom-instance-delete.md`
§5.2): (1) `lazyLoader.deleteInstanceRows` — the persistence, and it must run BEFORE
`_rawInstIndex` is touched since the row identity *is* `_rawInstIndex`;
(2) renumber `_rawInstIndex` on survivors, else `refFor` writes grouping refs at the
wrong instances and `finalizeLazyFrameGroup` hydrates the wrong 2D;
(3) `instanceGroups` cascade; (4) `frameGroups` cascade under the same `seen` Set
(hydrated frames share instance objects between the maps — the #195 lesson);
(5) prune `frameIdentityMap`. Never assigns `group.observedPoints` (read-only getter
since #189 — assigning throws in every ES module). App-level triangulation caches
are the caller's job: run `purgeTriangulationDataForGroup` over the returned
`purgedGroups`.

**`pruneOrphanIdentities` is not cosmetic.** `frameIdentityMap` is serialized into
the `.slp`, so residue can re-attach a ghost identity to a later instance reusing
the same `(frame, camera, track)`; and `ensureGroupsFromIdentities` RECREATES groups
from this map for any frame with no `instanceGroups` entry, so an unpruned entry
brings a deleted group back on the next Triangulate All. Goes through
`session.deleteFrameIdentity` because the keys are **packed Numbers** since #185 —
the raw `frameIdx + ':' + cam + ':' + track` string comparison used by the earlier
PR #153 implementation silently matched nothing, making its prune dead code.

**Imports from project modules.** None (deliberately).

**Tests.** `tests/test-custom-delete-ops.js` (19 cases), plus
`tests/test-custom-delete-store.js` for the store primitive it drives.

---

### ui/export-modals.js

**Purpose.** Modal dialogs for bulk-triangulation and export (Group-by-Track,
Group-by-Identity, multi-frame triangulation, SLP per-session, SLP by-camera,
SLP all-sessions, JSON labels, points3d H5, reproj H5).

**Key exports.**
- `showGroupByTrackModal()` — modal that bulk-groups by trackIdx.
- `groupByIdentityAndTriangulateAll(explicitMethod)` — bulk-group then
  triangulate. `explicitMethod` (`'ba'|'dlt'`) is the user's explicit pick when
  there was one — "Triangulate All ▸ DLT" routes here and passes `'dlt'`; omitting
  it (Tracks ▸ Group by Identity) means "use Settings ▸ Default Triangulation".
  Either way the resolved method **governs the whole sweep**. Ends by
  calling `update3DViewport(state.currentFrame)` so the 3D viewer populates for
  the current frame (this is the path "Triangulate All" takes when identities
  exist; previously it refreshed only the 2D overlays, leaving 3D empty).

  **Both grouping sweeps ADOPT existing 3D rather than re-solving it.** Each
  deletes a frame's `instanceGroups` and rebuilds fresh `InstanceGroup` objects
  around the SAME `Instance` objects. The fresh object carries no `points3d` and
  no `triangulationMethod`, so both used to re-solve every group with
  `triangulateAndReproject`'s DEFAULT method — a silent DLT — and stamp
  `triangulationMethod = 'dlt'`. Running "Group by Identity" (or Triangulate All ▸
  DLT, which routes here) or "Group by Track" after a **BA** Triangulate All
  therefore silently downgraded the whole project's 3D to DLT; since save/export
  read `group.points3d`, the exported file stopped matching what the user had
  computed and was looking at. Measured pre-fix on
  `tests/e2e/fixtures/ba-rig-fixture.js`: the exporter emitted DLT's 3D *exactly*
  (delta 0 from DLT, 0.098 world units from BA).

  Each sweep resolves ONE governing method up front (the explicit pick, else
  Settings ▸ Default Triangulation) and every group ends up with 3D from that
  method. A group is ADOPTED rather than solved — `findEquivalentPriorGroup` +
  `adoptPrior3d`, no solve at all — only when its membership is unchanged AND its
  existing 3D already came from that same method, i.e. only when re-solving is a
  provable no-op. So a DLT re-run over a DLT project solves nothing (measured: all
  16 fixture groups adopted, 4 ms) while switching the default to BA re-solves the
  project (0 adopted, 16 solved via BA, 13 ms — 3.0x, in line with the 3.4x
  per-group BA/DLT ratio measured on the same rig; larger skeletons measure
  ~4.6-6.1x). That cost is the user's explicit choice, so both sweeps name the
  method and report 3D provenance ("N kept existing 3D, N solved via Bundle
  Adjustment, N via DLT") in their progress text and status line — visible rather
  than hidden.

  Guarded by `tests/e2e/triangulate-all-ba-export.mjs` (six phases; 17 assertions
  confirmed failing pre-fix, 0 after). It drives Group by Identity directly and
  Group by Track through its real modal, and asserts the 3D
  `buildPoints3dExportData` emits — what `buildPoints3dH5` and the JSON labels
  export write — is bit-identical to an independent BA solve and NOT the DLT solve;
  plus governance in both directions (DLT-over-DLT adopts everything; BA-over-DLT
  re-solves everything) and that an explicit `'dlt'` beats a BA default.

  `group.triangulationMethod` IS persisted (per-group
  `metadata.lucid.triangulationMethod`), so adoption works across a reopen too and
  a reopened BA project still displays BA's error — see `pose/pose-data.js`'s
  `InstanceGroup` entry.
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
  `getInstanceGroupsForFrame`, `sweepLazyFrameWindows`,
  `resolveTriangulationMethod`, `findEquivalentPriorGroup`, `adoptPrior3d`,
  `triangulationMethodLabel` (the last four for the adopt-don't-downgrade rule).
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
  `swapTracks` and `swapAssignTrack` are **durable on a lazy project** (luc3d
  #195): each writes the columnar store through the private
  `swapTracksInStore` (→ `SioLazyLoader.remapTracksFromIdentity`) and then mirrors
  the swap into memory through `swapTracksInMemory`, which covers the resident
  `frameGroups` AND the project-wide `instanceGroups` placeholders under one
  `seen` set. See "A store write must be mirrored into `instanceGroups`" above for
  why both maps are required and why the de-duplication is load-bearing. The
  reported count is the durable row count when a store exists, the in-memory
  changed count otherwise.
- Manual identity switch: `applyIdentitySwitch`, `describeIdentitySwitch`
  (luc3d #172). **The single entry point for "the user picked a different ID for
  this instance"** — the `1`–`9` hotkeys (`assignIdentityToSelected`), the Linked
  Instance Groups identity dropdown and the unlinked-row identity dropdown
  (`ui/info-panel.js`) all route through it so they cannot drift. Two modes:
  - **swap** — the selection already reads as identity A and the user picks B, so
    A and B are EXCHANGED from the current frame to the end of the timeline in
    every view via `Session.swapIdentitiesForward`. A correction is a statement
    about the rest of the video, exactly as SLEAP's `track_swap` is for tracks.
    The private `resolveCurrentIdentityId` reads the CURRENT identity the way
    `getGroupColor` does — the per-frame entry for one of the selection's own live
    (camera, trackIdx) pairs first, `group.identityId` only as a fallback, because
    that field is stale on every frame but the last assignment's (#155).
  - **propagate** — nothing to swap away from (fresh project / just-grouped group
    / "none" picked), so it falls back to the per-camera, per-track forward stamp
    (`assignIdentityToGroup` + `Session.propagateIdentity`), the only continuity
    signal available in that state.
  - **frame** — the unlinked row's instance is TRACKLESS (the optional
    `unlinkedInstance` argument, passed by both unlinked call sites, has
    `trackIdx == null`). `frameIdentityMap` cannot key a null track and no
    linkage exists to carry the correction to other frames, so this routes to
    `Session.assignIdentityToUnlinkedTrackless`: per-frame, instance-level,
    with an in-frame swap against the same camera's trackless row already
    holding the target identity. `describeIdentitySwitch` says "this frame"
    honestly instead of implying propagation (luc3d #201 recurrence).

  The optional `scopeCamera` argument restricts either map mode to ONE camera
  (luc3d #201), via `Session.swapIdentitiesForwardInCamera` in swap mode. Passed
  by the two UNGROUPED call sites — the unlinked-row dropdown in
  `ui/info-panel.js` and the `selectedUnlinked` branch of
  `assignIdentityToSelected` — and omitted by the group ones. Rationale: an
  ungrouped instance is one 2D detection belonging to no cross-view bundle, so a
  correction on it speaks for that camera only, and fixing a single view is the
  reason to ungroup at all (ungroup → switch the wrong view → regroup). The
  all-views argument holds for a GROUP, which by definition asserts one animal
  across cameras. A scoped swap does not pin `group.identityId` (there is no group,
  and that field is shared by all views). The result carries `camera` so
  `describeIdentitySwitch` reports "cam2 only" instead of claiming "all views".

  This replaced a `for (cam of sel.instances) propagateIdentityForward(...)` loop
  that was scoped to **one raw track and only the cameras the group was visible in
  on that frame**, so a switch covered a few hundred frames of a multi-thousand-
  frame project and skipped any view where the animal was occluded right then —
  luc3d #172. Measured on `tests/e2e/identity-switch-propagates-to-end.mjs`
  (3,000 frames × 3 cameras, raw tracks fragmented every 200 frames): 100 of
  2,700 remaining frames in 2 of 3 cameras before, 2,700 of 2,700 in all 3 after,
  surviving save + reopen. `describeIdentitySwitch` builds the status text so the
  reported count is what actually changed — a plausible-looking count over a
  silently truncated range ("propagated to 200 future instances") is exactly how
  #172 hid. Still **forward-only**: earlier frames are never re-stamped (#155),
  and `assignTrackToIdentity` (which re-stamped EVERY frame of a track) remains
  uncalled. Whole-track identity assignment is still available via
  **Tracks ▸ Propagate Tracks → IDs**.
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
  `updateTimelineForFrame`, `triangulateCurrentFrame`,
  `resolveTriangulationMethod`.

**Three `triangulateAndReproject` call sites, two of which write 3D.** The two
that write it (`autoAssign`'s "auto-triangulate all groups for this frame" loop
and `autoAssignAcrossFrames`' per-new-group solve) now pass
`resolveTriangulationMethod(group)`. The first is the load-bearing one: it sweeps
**every** group on the frame, including pre-existing bundle-adjusted ones, and
passing no method silently re-solved them with DLT and overwrote `points3d` —
which is what save/export read. The third, the O(nRef × nOther) **Hungarian cost
matrix**, is deliberately DLT — its temporary groups' 3D is discarded, only the
relative ordering of the errors matters, and BA's ~3x-6x cost would buy nothing —
and it passes `{ method: 'dlt' }` explicitly rather than relying on the default, so
that no call site in the app depends on that default (enforced by
`tests/test-triangulation-method-propagation.mjs`). (This module already used `getDefaultTriangulationMethod()` for its
`triangulateCurrentFrame` call, so honoring the user's method here is consistent
rather than new policy.)
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

**Reprojection Error panel (`updateFrameInfo`, issue #135).** The headline mean,
undistorted residual, method label, and per-camera rows are the frame SUMMARY
(averaged over every triangulated instance). The "Per-instance node breakdown"
`<details>` then renders ONE per-node × per-camera table PER instance, each
labelled with a color dot + track/identity (identity preferred, then track, then
`Instance N`) and that instance's own mean error, ordered by label. This
replaced the earlier single table that averaged all instances together and hid
which animal/node/view carried a large error. Reads each `state.triangulationResults`
entry's `{ group, errors, meanError }` — a shape all three producers supply
(`pose/triangulation.js`'s sweeps, `import-export/save-load.js`'s load-time
rebuild, and `ui/rendering.js`'s lazy per-frame fill), so the panel populates
for freshly-triangulated AND reopened projects alike.
  **Label/color resolution reuses the canonical resolvers on purpose** — the
  panel must never disagree with what the same group shows elsewhere:
  - *Track*: the first member instance that actually CARRIES a track, scanning
    every camera (not `instances`' first entry, which can be a trackless view
    while its siblings are tracked) — the same scan `getGroupColor` and the
    identity `<select>` below use.
  - *Identity*: `session.getIdentityIdForTrack(cam, trackIdx, frameIdx)` FIRST,
    falling back to `group.identityId`. `group.identityId` is only refreshed on
    the frame an identity is (re)assigned, so reading it first labelled these
    tables with the PRE-fix animal on every frame a propagated swap fix covers
    (issue #155/#168). Mirrors the identity dropdown's pre-select exactly.
  - *Color*: `getGroupColor(group, session, state.colorByIdentity, frameIdx)`,
    so the dot matches the 2D views and 3D viewport — it honors
    Color-by-Identity mode and carries the #168 wildcard-identity and #183
    frame-0 trackIdx-collision guards that a bare `getTrackColor(trackIdx)`
    bypasses (which painted two different animals the same color on exactly
    the frames those fixes cover).
  - The synthetic "No ID" track (`isNoIdTrack`) is not shown as an animal name.
  **Only results for THIS frame's live groups are rendered.**
  `state.triangulationResults` is derived state that outlives the groups it
  describes: "Triangulate All" routes to `groupByIdentityAndTriangulateAll`
  whenever identities exist, which DELETES and rebuilds each frame's
  `instanceGroups` but — unlike every other bulk path, which either `set()`s per
  frame (`groupByTrackAndTriangulateAll`, `triangulateAllFrames`) or `clear()`s
  wholesale (`sweepTriangulateAllFrames`) — never prunes the results map, and
  `ui/rendering.js`'s lazy fill then CONCATENATES its freshly-computed entries
  onto whatever was already stored. A frame the user had already triangulated
  therefore holds results for both the deleted groups and their replacements,
  which rendered as TWO tables per animal (measured: 4 tables for 2 animals).
  The breakdown filters `results` against the `instanceGroups` argument, keeping
  entries with no `group` (they use the `Instance N` fallback) and skipping the
  filter entirely when no group list was passed, so neither case can blank a
  panel that used to populate. Deliberately display-side: the triangulation
  paths are verified against the real project and are left untouched, so the
  frame-summary headline still averages every stored entry.
  Labels are resolved ONCE up front against each result's ORIGINAL index (so the
  `Instance N` fallback numbering doesn't shuffle with the sort) and the original
  index breaks label ties, keeping several trackless groups in a stable order
  frame to frame. Covered by `tests/e2e/rpe-per-instance.mjs`, which asserts the
  per-instance split, the all-camera track scan, per-frame-identity precedence
  over a stale `group.identityId`, and dot/`getGroupColor` agreement in both
  color modes.

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
- `./overlays.js` — `REPROJECTION_COLOR`, `getTrackColor`, `getGroupColor`.
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
- `./identity-assignment.js` — `swapAssignTrack`, `applyIdentitySwitch`,
  `describeIdentitySwitch` (`propagateIdentityForward` is no longer imported —
  `applyIdentitySwitch` subsumes it). Both identity `<select>`s (the
  Linked Instance Groups row and the unlinked row) drive their change through
  `applyIdentitySwitch`, so a manual ID switch exchanges the two identities to the
  end of the timeline (luc3d #172) and reports its real count via
  `describeIdentitySwitch`. They differ in SCOPE: the grouped row switches every
  view, while the **unlinked row passes its own camera as `scopeCamera`** so the
  correction touches that view only (luc3d #201) — the ungroup → fix one view →
  regroup workflow — and passes its instance so a TRACKLESS row takes the
  per-frame instance-level path (`applyIdentitySwitch` mode **frame**; picking
  "—" on a trackless row clears `Instance.identityId` directly, there being no
  map entry to clear). The unlinked row's ID `<select>` pre-selects from
  `getIdentityIdForUnlinkedInstance` (per-frame map entry for a tracked row,
  instance-level retained identity for a trackless one), which is why
  `Session.unlinkGroup` has to retain the
  disbanded group's identity in the map / on the instance for the row to read as anything
  but "—".
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
  panel's gray on the skeleton. When coloring by identity,
  `getInstanceColor` also honors a TRACKLESS unlinked instance's retained
  `Instance.identityId` (luc3d #201 — stamped by `unlinkGroup`; the map
  cannot key a null track) before falling back to `UNGROUPED_USER_COLOR`,
  so an ungrouped animal keeps the color it had while grouped. **When coloring by identity,
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
  **`drawUnlinkedInstances` same-trackIdx collision fix:** an unlinked
  instance (no group, no identity — e.g. an animal visible in only 1 camera
  this frame, so `commitTrackedFrame`'s `members.length < 2` check never
  groups it) colors purely via `getInstanceColor`'s raw `instance.trackIdx` —
  there's no `group.identityId` to fall back to the way `getGroupColor` does
  for linked instances. Two DIFFERENT unlinked instances in the same
  (camera, frame) that happen to share that raw trackIdx (an upstream
  tracking-data property, not something LUCID's tracker assigns) used to
  render as the exact same color with nothing to distinguish them. Fixed by
  precomputing, per draw call, an occurrence index for each trackIdx among
  the type-filtered instances actually being drawn together, and darkening
  (`adjustColorBrightness`, floored at 0.35 so several collisions never
  converge to black) every occurrence after the first. Regression test:
  `tests/e2e/unlinked-instance-color-collision.mjs` (two colliding
  instances + one non-colliding control, asserts the collision pair gets
  distinct colors and the control is unaffected — confirmed it fails
  pre-fix, both colliding instances resolving to the identical color, and
  passes post-fix).
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

  **Lazy reprojection fill — honors the group's triangulation method.** A group
  with `points3d` but no `reprojections`/`reprojectedInstances` is re-solved here
  and the result is written into `state.triangulationResults` (which is what the
  Info Panel's headline error, per-camera rows and per-instance breakdown read).
  That re-solve passes
  `{ method: group.triangulationMethod === 'ba' ? 'ba' : 'dlt' }` — the same
  method-preserving rule as `reTriangulateGroup`
  (`pose/triangulation.js`) — and carries `method` through into the stored
  result. It previously passed **no options**, and
  `triangulateAndReproject`'s `options.method === 'ba' ? 'ba' : 'dlt'` default is
  SILENT, so it re-solved with DLT. That is why **"Triangulate All ▸ Bundle
  Adjustment" appeared to do nothing:** the windowed sweep
  (`sweepTriangulateAllFrames`) deliberately drops `reprojections` and
  `state.triangulationResults` project-wide (~1.9 GB at 531,799 groups — see its
  docstring), so this fill is the ONLY thing that repopulates them, and the DLT
  re-solve overwrote BA's error with DLT's while `group.triangulationMethod`
  still read `'ba'` — so the panel labelled the number "Bundle Adjustment" and
  showed DLT's value. The single-frame `triangulateCurrentFrame` path was
  unaffected because it stores its own result AND populates `reprojections`, so
  this condition is false. `points3d` is deliberately **not** written back
  (the group already holds the authoritative 3D from the sweep); with the method
  honored the two are bit-identical, which
  `tests/e2e/triangulate-all-ba-display.mjs` asserts directly.
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
- `clampRotation` (a **re-export** of `ui/video-filters.js`'s, which is where the
  function now lives — existing importers are unaffected), `syncRotationUI`.
- `applyVideoFilters(view)` — write the COMBINED brightness+contrast CSS filter
  onto a view's canvas (see below).
- `restoreViewRotation(view)` — re-seed `view.rotation` from the session, the
  non-CSS counterpart of `applyVideoFilters` (see below).
- `populateViewStrip`, `populateSessionsPanel`, `populateSessionStrip`.
- `showMoveVideoModal`.
- `removeSession`, `switchSession` (async).

**Imports from project modules.**
- `./app-state.js` — `state`, controllers + setters.
- `../pose/pose-data.js` — `FrameGroup`, `UnlinkedInstance`, `Camera`.
- `../pose/triangulation.js` — `triangulateAndReproject`,
  `storeReprojectedInstances`, `getInstanceGroupsForFrame`,
  `sessionHasCalibration`, `resolveTriangulationMethod`. Moving a view between
  sessions strips that camera from every group in the origin session, which
  genuinely invalidates their 3D — so those groups ARE re-solved, but with
  `resolveTriangulationMethod(group)` and the result's method stamped back, so a
  bundle-adjusted group is not silently downgraded to DLT (it previously passed no
  method, i.e. a silent DLT, changing both the displayed 3D and what a later
  save/export writes).
- `../loading/session-loader.js` — `cellResizeObserver`,
  `createViewForVideoFile`, `rebuildVideoController`,
  `fitCanvasesToCells`, `updateTotalFrames`.
- `../loading/video.js` — `OnDemandVideoDecoder`.
- `../import-export/save-load.js` — `setStatus`, `showLoading`,
  `hideLoading`, `quickSave`, `markDirty`.
- `./video-filters.js` — the `CONTRAST_*` / `BRIGHTNESS_*` / `ROTATION_*`
  bounds, `clampContrast` / `clampBrightness` / `clampRotation` /
  `clampRotationSetting`, `buildVideoFilter`, and the three per-session
  get/set pairs. `clampRotation` is **re-exported** from here so
  `ui/ui-wiring.js` (which has always imported it from this module) is
  unaffected by the move.
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
strip (top), session strip (bottom), per-pane brightness/contrast/rotation
controls, switch-session UX, move-video-between-sessions modal.

**Video display settings — brightness, contrast (issue #149) and rotation.**
`populateVideoBrightnessTable`, `populateVideoContrastTable` and
`populateVideoRotationTable` render the Visibility tab's per-view tables
(`#visVideoBrightnessTable`, `#visVideoContrastTable` — each with a `Select All
Videos` link toggle — and `#visVideoRotationTable`, which is per-camera only).

All three are stored **per SESSION** (`session.videoBrightness` /
`videoContrast` / `videoRotation`) and persisted in the `.slp` via
`import-export/visibility-metadata.js`. `switchSession` throws `state.views`
away and rebuilds every pane, so a per-view field silently resets — which is
precisely what brightness did before it moved onto the session. Any slider edit
calls `markDirty()`: these are project state, not browser-local preferences.

They restore in two different ways, because only two of them are CSS filters:
- **Brightness + contrast** funnel into the single
  **`applyVideoFilters(view)`**, which composes
  `buildVideoFilter(getSessionBrightness(...), getSessionContrast(...))` into ONE
  `style.filter` string. They must share one writer: both target the same CSS
  property, so applying them independently would have the second write erase the
  first.
- **Rotation** is not display-only — the renderer and hit-testing read
  `view.rotation`. **`restoreViewRotation(view)`** re-seeds that field from the
  session; without it a saved rotation would load into the session and show
  correctly in the table while the video rendered un-rotated.

`VideoPaneRenderer.init`/`update` call `restoreViewRotation` then
`applyVideoFilters` right after assigning `view.canvas` — that is what restores
each session's own settings on a switch (and on a reopen). The hold-to-rotate
gesture in `ui/ui-wiring.js` keeps a FRACTIONAL `view.rotation` while animating
and commits the rounded degree to the session once, on keyup.
`applyVideoFilters` also writes the filter onto any **duplicate panes** of the
same view. Mirror panes receive their pixels via `drawImage`
(`renderDuplicatePanels`), which copies raw pixel data and does not inherit the
primary canvas's CSS filter — so without this they showed the unfiltered video
(this also fixes that pre-existing gap for brightness).

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
- `serializeHiddenSets(session)` → a partial `metadata.lucid` fragment carrying
  only the NON-EMPTY sets (`hiddenCameras` / `hiddenTracks` /
  `hiddenIdentities`), or **`null`** when nothing is hidden. Names are sorted,
  so the written bytes depend on which entities are hidden and not on the order
  the user clicked them.
- `ingestHiddenSets(session, lucid)` — merge saved arrays back onto the Sets.
  Reads all three keys off ONE object, so a caller cannot wire up two of the
  three and silently drop the last. Additive, idempotent, and tolerant of a
  missing/garbage payload. Returns the count applied.

**Per-session state.** Lives directly on the `session` object as `Set<string>`
fields (keyed by entity NAME, including identities). Empty by default — fresh
sessions / new entities default to visible. Naming convention `_foo`
mirrors Block 1's `_timelineHeight` / `_timelineCollapsed`. Never cached in
localStorage (a browser-local cache would be wrong for what is project state),
but **persisted per session into the `.slp`** via the serialize/ingest pair
above — which is also why `ingestHiddenSets` does not validate names against
the session's current entities: a stale entry is harmless (it simply never
matches), exactly as it is after a delete.

**Global mirror.** Bottom of the file exposes the same surface on
`window.TimelineVisibility.*` and individually on `window.toggleCameraVisibility`
etc., guarded by `typeof window !== 'undefined'`. The mirror is what the
browser test runner and the headless node sandbox use to resolve the API
under either lookup style.

**Imports from project modules.** None.

**Imported by.** `ui/info-panel.js` (toggle helpers + list helpers),
`ui/ui-wiring.js` (rename-migration helpers),
`import-export/visibility-metadata.js` (the serialize/ingest pair).
`ui/timeline.js` intentionally does **not** import this module — it inlines its
own `ensureHiddenSets` equivalent so the timeline core stays decoupled from the
visibility-panel wiring.

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
  On a lazily reopened project it ALSO re-indexes the columnar store's
  `instancesData.track` column via `session.lazyLoader.remapTracksFromIdentity`
  (deleted → the store's -1 trackless sentinel, higher → shift down one), the same
  mapping the resident pass applies. Without that, deleting a track was not merely
  an unapplied update but silent project-wide CORRUPTION: `session.tracks` shrinks
  while every non-resident instance keeps its old index, so on save each instance
  above `idx` points at the WRONG track name.
- `deleteIdentityAt(session, idx)` — **ungroups** every GroupedInstance carrying
  the id (matched via `group.identityId` OR, pre-triangulation, via the per-frame
  `getIdentityIdForTrack`; falls back to nulling `group.identityId` in sessions
  without `unlinkGroup`), clears the per-frame `frameIdentityMap` entries pointing
  at it (so instances resolve to "no identity"), splices the identity, and drops
  the hidden-identities entry. Returns the name.

**Imports from project modules.** None (operates on the passed `session`) — it
reaches the columnar store through the `session.lazyLoader` handle it is given.

**Imported by.** `ui/ui-wiring.js`. Bridged into `tests/test-runner.html` and
covered by `tests/test-track-identity-modals.js`; the lazy/durable half of
`deleteTrackAt` is covered by `tests/e2e/sequence-lazy-workflow.mjs` (cycle 5b).

---

### ui/video-filters.js

**Purpose.** Per-CAMERA video display settings — brightness, contrast (issue
#149) and rotation. Pure and DOM-free: it imports NO project modules, so it can
be bridged into `tests/test-runner.html` and the `vm` sandbox runner without
dragging `app.js` in. `ui/sessions-panes.js` owns the DOM half (the
Visibility-tab tables) and calls in here for the math and the per-session stores.

**One store shape, three settings.** All three are per-camera and live on the
SESSION as a plain `{ cameraName: value }` map (`Session.videoBrightness` /
`videoContrast` / `videoRotation`), because `state.views` is rebuilt from
scratch on every session switch — anything parked on a view silently resets.
Each has a default that is NEVER written to the map or to the `.slp`, so a
project the user never adjusted serializes exactly as before these settings
existed. The four store primitives (`readSetting` / `writeSetting` /
`serializeSetting` / `ingestSetting`) are shared by all three, so a change to
the default-omission rule cannot apply to two of them and silently skip the
third. Brightness and contrast are pure CSS `filter` components; rotation is a
geometric transform the renderer and hit-testing consume via `view.rotation`
(this module owns only its clamp, its store and its serialization).

**The contrast mapping.** CSS `filter: contrast(k)` is a per-channel linear
transfer function pivoted on mid-grey — `out = k * in + (0.5 - 0.5 * k)` on
normalized channel values. `k = 1` is identity, `k > 1` pushes values away from
0.5 (more contrast), `k < 1` collapses them toward 0.5, and `k = 0` flattens the
image to mid-grey. So the bipolar slider is a straight affine map with no branch
on sign: `k = 1 + s / 100` for `s ∈ [-100, 100]` → `k ∈ [0, 2]`, mirroring the
brightness slider's 0..200 % → `brightness(0..2)`.

**Key exports.**
- `CONTRAST_MIN` / `CONTRAST_MAX` / `CONTRAST_DEFAULT` (−100 / 100 / 0),
  `BRIGHTNESS_MIN` / `BRIGHTNESS_MAX` / `BRIGHTNESS_DEFAULT` (0 / 200 / 100),
  `ROTATION_MIN` / `ROTATION_MAX` / `ROTATION_DEFAULT` (−179 / 180 / 0).
- `clampContrast(v)` / `clampBrightness(v)` — coerce anything (number, slider
  string, `null`, `NaN`, out-of-range) to a valid integer setting; junk falls
  back to the default rather than producing `NaN`.
- `clampRotation(deg)` — wrap degrees into (−180, 180]. **Moved here verbatim
  from `ui/sessions-panes.js`** (which re-exports it, so `ui/ui-wiring.js` and
  any other importer are unaffected) to put it in the dependency-free module the
  test runners can bridge. Deliberately does NOT round: the hold-to-rotate loop
  in `ui/ui-wiring.js` advances by a fractional `60 * dt` per frame and needs the
  sub-degree precision to look smooth.
- `clampRotationSetting(v)` — what the store and the `.slp` hold: an INTEGER
  degree in [−179, 180]. Rounds **before** wrapping, because `clampRotation`
  maps into (−180, 180] — an open lower bound — so an input just under −179
  comes back as ~180.9999, and rounding that afterwards would yield 181, one
  past the max. Round-then-wrap is closed under the integer range.
- `contrastFactor(v)` / `brightnessFactor(v)` — slider value → CSS amount.
- `buildVideoFilter(brightness, contrast)` → the COMBINED filter string
  (`''` / `'brightness(1.15)'` / `'brightness(1.15) contrast(0.6)'`). Both
  settings share `canvas.style.filter`, so they must be emitted together —
  writing them separately makes the second assignment erase the first. Identity
  components are omitted, and an all-identity pair yields `''`, so an untouched
  project leaves `style.filter` exactly as it was before contrast existed.
- `getSession{Contrast,Brightness,Rotation}(session, camName)` /
  `setSession{Contrast,Brightness,Rotation}(session, camName, value)` — the
  per-session stores. The SESSION, not the view, is the source of truth:
  `state.views` is rebuilt from scratch on every session switch, so a per-view
  field would silently reset. `set` returns the clamped value actually stored
  and **deletes** default entries.
- `serializeVideo{Contrast,Brightness,Rotation}(session)` → the matching
  `metadata.lucid` payload or **`null`** when nothing is worth writing (writers
  must omit the key on `null`, which is what keeps untouched projects
  byte-identical — `tests/e2e/save-golden-digest.mjs`).
- `ingestVideo{Contrast,Brightness,Rotation}(session, raw)` — merge a saved
  payload in, clamping and dropping anything unusable; tolerates a
  missing/garbage payload (older `.slp` files have no such key). Returns the
  count applied.

Callers normally reach the serialize/ingest half through
`import-export/visibility-metadata.js` rather than one setting at a time.

**Imports from project modules.** None, by design.

**Imported by.** `ui/sessions-panes.js` (the three tables + `applyVideoFilters`
+ `restoreViewRotation`, and the `clampRotation` re-export), `ui/ui-wiring.js`
(`setSessionRotation`, to commit the hold-to-rotate gesture),
`import-export/visibility-metadata.js` (the `metadata.lucid` mapping every
reader and writer goes through). Bridged into `tests/test-runner.html` and
covered by `tests/test-video-contrast.js` (contrast) and
`tests/test-visibility-metadata.js` (brightness, rotation); the real-app halves
are `tests/e2e/contrast-slider-roundtrip.mjs` and
`tests/e2e/visibility-settings-roundtrip.mjs`.

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

**Visibility panel — the global/session split.** `saveVisSettings` /
`restoreVisSettings` cache the panel's **global appearance preferences** (the
`visSliderIds` / `visCheckIds` / `visStyleIds` lists — User, Predicted,
Reprojections, Display Legend and 3D Viewer) in
`localStorage.visibilitySettings`. Those are browser-local display taste, shared
across every session, and are deliberately **not** written into the `.slp`:
baking them into the project file would make opening a colleague's project
silently reassign your node sizes and 3D widgets. The panel's *session-scoped*
settings — per-camera video brightness / contrast / rotation and the timeline
hidden sets — take the opposite route and persist per session via
`import-export/visibility-metadata.js`; they never touch localStorage.

**Hold-to-rotate (`Shift+R` + `←`/`→`).** `rotationLoop` advances
`view.rotation` by a fractional `60 * dt` every frame so the animation stays
smooth, and keeps the session store out of it. The gesture is committed **once,
on keyup**: `setSessionRotation` stores the rounded degree, `view.rotation`
snaps onto exactly that value (so what renders after the gesture is what a
reopen will render), and `markDirty()` fires. Persisting per animation frame
would be 60 Hz of churn on project state.

**Imports from project modules.** Nearly every other module — see file
header for the full list. Notable ones: `app-state.js`,
`timeline-controller.js`, `pose-data.js`, `triangulation.js`,
`rendering.js`, `info-panel.js`, `save-load.js`, `slp-import.js`,
`file-io.js`, `session-loader.js`, `video.js`, `tracker.js`,
`initialization.js`, `identity-assignment.js`, `export-modals.js`,
`sessions-panes.js`, `settings.js`, `settings-modal.js`,
`video-filters.js` (`setSessionRotation`; `clampRotation` still comes in via
`sessions-panes.js`, which re-exports it).

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
default method. The **environment-skeleton** solve (Load Environment) likewise
takes it, via `resolveTriangulationMethod(group)` on a brand-new group; it used
to hardcode DLT, so a BA user's environment 3D silently disagreed with the method
they had selected.

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
- `showCustomDeleteModal()` — **Edit ▸ "Custom Instance Delete…"** (menu item
  `#menuCustomDeleteInstance`), LUCID's equivalent of SLEAP's
  Labels ▸ Custom Instance Delete… Six selects: `Delete` (predicted — the SLEAP
  default — / user / all), `Grouping` (any / grouped only / ungrouped only, which
  is ORTHOGONAL to type), `in` (current frame / current session — LUCID's analogue
  of SLEAP's "current video", since a session shares one frame index space),
  `in view` (all / one camera), plus `with track` / `with identity` rows shown only
  when the session has any. A live count, a per-camera breakdown table with a Total
  (same shape as `showDeleteModal`'s), and a **cascade line** — "N group(s)
  removed · N ungrouped · N lose their 3D · N predicted instance(s) promoted to
  User" — because the ≥2-member invariant makes those consequences both surprising
  and irreversible. Esc closes; Delete is an explicit click (never Enter). On
  apply it re-collects (the model can move under an open dialog), clears the
  selection FIRST (a stale `selectedInstanceGroup` would point at a deleted object,
  and `viewport3d.selectedInstanceIdx` is a positional index that re-indexes under
  any group removal), runs `executeDeletion`, then
  `purgeTriangulationDataForGroup` over the returned `purgedGroups` (the ops module
  is import-free by design), and reports the **durable** store-row count rather
  than the resident one — surfacing `errorRows` as a warning instead of claiming
  success. All matching/cascade/durability logic is in `ui/custom-delete-ops.js`;
  this is only the dialog. No keyboard shortcut (matching SLEAP), so no
  `ACTION_CATALOG` entry. Covered by `tests/e2e/custom-delete-modal.mjs`.
  Deliberately does NOT copy SLEAP's `labels.clean()` cascade, which also prunes
  unused tracks and skeletons project-wide — LUCID has an explicit `Delete Track…`
  and enforces one skeleton per project, so that would be data loss by surprise.
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

**Imports from project modules.** `../pose/pose-data.js` —
`points3dNodeCount`, `getPoint3d` (luc3d #189). This is the module's only
project import and it adds no cycle (`pose-data.js` is a leaf with no imports of
its own): `InstanceGroup.points3d` is a flat `Float64Array(3N)` with all-NaN
triples for missing nodes, so reading it needs the shared codec rather than
array indexing. No app-state coupling — data still arrives via the options bag.
Otherwise uses the global `THREE` from CDN script tags.

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

`rebuildVideoController()` surfaces frame-accurate mediabunny backend
failures in the status bar (issue #115) — previously a decoder that fell
back to HTML5 seeking only logged a `console.warn`, invisible without
opening devtools. Any view with a real decoder but no `_mbBackend` (its
`_initMediabunny`/`switchSource` init silently failed) now triggers
`setStatus('N of M camera(s) fell back to HTML5 seeking...', 'warning')` so
it's visible at a glance right after every load/session-switch, without
needing to check the console or set anything manually.

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
Before drawing the first grouped frame, calls `setReprojErrorVisible(true)`
(`ui/rendering.js`) whenever the reconstructed session has any
`instanceGroups` — every OTHER path that populates 3D/reprojection data
(Triangulate All, slp-import.js, save-load.js, identity-assignment.js, …)
already did this, but the lazy-reopen path didn't, so `#reprojErrorSection`
stayed at its HTML `display:none` default forever after a reopen even though
`drawAllOverlays`'s lazy-reproject block was silently computing a real error
underneath (visible only via the 2D/3D viewers, which don't gate on this
section) — the Instance panel's reprojection-error readout looked permanently
blank until the user manually re-ran Triangulate All. Covered by
`tests/e2e/reopen-reprojection-panel-autopopulate.mjs`.

**Imports from project modules.**
- `../ui/app-state.js` (incl. `buildRememberedSkeleton`), `../pose/pose-data.js`,
  `./video.js`, `../import-export/file-io.js`, `../pose/triangulation.js`
  (`shouldUseLazyH5`, `shouldUseLazySlp`, `LazyFrameLoader`),
  `./sio-lazy-loader.js` (`SioLazyLoader`),
  `../import-export/save-load.js`,
  `../ui/rendering.js` (`drawAllOverlays`, `setReprojErrorVisible`),
  `../ui/info-panel.js` (`updateInfoPanel`),
  `../import-export/skeleton-json.js` (`parseSkeletonJSON`),
  `../import-export/slp-import.js`, `../ui/loading-progress-modal.js`,
  `../import-export/import-track-resolve.js`,
  `../pose/initialization.js`, `../ui/sessions-panes.js`, `../ui/ui-wiring.js`,
  `../import-export/visibility-metadata.js` (`readVisibilityMetadata`, for the
  lazy-reopen read of the session-scoped Visibility settings).

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
`reconstructInstanceGroupsFromSessionLazy`; **now also computes each camera's
`trackOccupancy` entry at load time**, same as `open()` — found missing via a
real Playwright test run (`tests/test-lazy-reopen.js`): reopening an
already-saved project left the Tracks Timeline with NO occupancy data for any
camera until a propagate action happened to rebuild it, unlike the per-camera
`open()` path which always had it from the start), `getFrame` / `getFrameSync`
(adapt typed instances → `{trackIdx, score,
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
nFrames, rowMap?)` — one O(nInstances) pass over the columnar store (`framesData.frame_idx` +
`instance_id_start/end`, `instancesData.track`) emitting **sparse** per-track
run-segments `{ sparse:true, nTracks, nFrames, segments:Map<trackIdx,[{start,end}]>,
counts:Map<trackIdx,frameCount> }` — never a dense nFrames×nTracks grid (a ~108k×1000s
prediction dump would be huge). The optional `rowMap` (videoFrameIdx → store row)
restricts the scan to one camera's own rows, sorted by frame — **required**
whenever `labels`'s store is SHARED across multiple cameras
(`openProjectSlp`'s one interleaved store, or `remapTracksFromIdentity`'s
occupancy rebuild for the same reason), since without it the scan would mix a
DIFFERENT camera's rows in with this one's (found via a real Playwright test
run — both call sites passed no `rowMap` at all before this, so the shared-
store case either silently produced wrong occupancy or, for `openProjectSlp`,
was never called at all). Omit for the per-camera `open()` path, where every
row in that store already belongs to exactly one camera. Relies on the SLP
on-disk frame ordering (same invariant `appendStore` assumes); zero frame
materialization. `session.trackOccupancy` picks it up
(`session-loader.js`); the timeline reads the `sparse` flag (`_buildTrackSegments`) and
caps rendered rows (first-N per camera by appearance). See `ui/timeline.js`.

**`_computeSparseOccupancy` shared-store `rowMap` param.** `openProjectSlp`
(the single-`.slp` project-reopen path) shares ONE interleaved columnar store
across every camera — scanning it without scoping to one camera's rows would
mix every camera's data into a single occupancy result. `_computeSparseOccupancy`
takes an optional `rowMap` (camName → videoFrameIdx→store-row, from
`frameRowByCam`) that restricts the scan to just that camera's sorted rows;
omitted, it scans every row (correct for the per-camera `open()` path, which has
no shared store). `openProjectSlp` used to never call this at all — occupancy
was silently `null` for a reopened project, and the same latent gap existed in
`remapTracksFromIdentity`'s post-propagate occupancy rebuild (called this with no
`rowMap` despite iterating per-camera in a potentially-shared-store context).
Both fixed: `openProjectSlp` now computes occupancy for every camera right after
determining `nFrames`, passing each camera's own `rowMap`; `remapTracksFromIdentity`
passes `this.frameRowByCam.get(camName)`. Regression:
`tests/test-lazy-reopen.js`'s "propagateIdentitiesToTracks rebuilds the lazy
loader's trackOccupancy (Tracks Timeline bug)" test.

**Sort-skip optimization (now that occupancy is actually computed on every
reopen).** `_computeSparseOccupancy`'s shared-store branch used to
unconditionally `.sort()` the per-camera row list by frame index before
scanning it — an O(n log n) cost with a lookup-heavy comparator, real at
180k+ rows/camera on a large project (previously invisible since
`openProjectSlp` never called this function at all — see above). A single
camera's own rows are already in on-disk frame order: `openProjectSlp`
scans the shared store's native row order and appends to each camera's
`frameRowByCam` map in that same order — the same frame-ordering invariant
`appendStore`/#161 rely on elsewhere — so the sort is normally a no-op.
Fixed to verify with one cheap O(n) linear pass first, and only pay for the
actual `.sort()` when a row is genuinely out of order (never trades
correctness for speed — same result either way). Verified on a real
`openProjectSlp` round trip (3 cameras × 3000 on-disk-ordered frames): zero
`Array.prototype.sort()` calls. Regression test:
`tests/e2e/occupancy-sort-skip-optimization.mjs` (asserts zero sort calls
for real ordered data, confirms the fallback sort still engages and
produces the IDENTICAL correct segments for a deliberately shuffled rowMap).

**`deleteInstanceRows(shouldDeleteFn)` — the durable-delete primitive (Custom
Instance Delete).** Permanently removes instance rows from the columnar store so a
bulk delete survives eviction, re-hydration, save and reload. Companion to
`remapTracksFromIdentity`; same diagnostics contract
(`{deleted, errorRows, firstError, byCamera}`, per-row `try/catch`, `console.error`
on `errorRows`). Exists because a resident-only delete fails **twice**: (1) without
even saving — `finalizeLazyFrameGroup` re-derives `fg.instances` from store rows and
puts any row with no matching `_rawInstIndex` member into the UNLINKED pool, so
scrubbing away and back resurrects it; and (2) on save — `appendStore` copies the
columns verbatim with no per-instance filter, and the user-correction overlay skips
any camera-frame with no resident *user* instance and bails on
`lucidInsts.length === 0`, so an emptied camera-frame streams back unchanged.
Mutating the store is the only thing that fixes both.
- Compacts every `instancesData` column of length `nInst` (iterates `Object.keys`,
  so a schema addition is carried through; `col.constructor` preserves typed-vs-plain
  and int-vs-float). **Leaves `pointsData`/`predPointsData` alone on purpose** —
  `appendStore` walks points PER SURVIVING INSTANCE via `point_id_start/end`, so
  orphaned point rows are never visited and never written.
- **Keeps frame rows** (`frameRowByCam` is keyed by row index, and `refFor`,
  `releaseFrame` and `_computeSparseOccupancy` all depend on that indexing). A frame
  whose range collapses to `start === end` is written by `appendStore` as an empty
  `LabeledFrame` — LUCID's answer to SLEAP's "empty LabeledFrames are removed".
- Renumbers via a prefix sum (`survBefore`), so it does **not** assume frame rows are
  sorted by `instance_id_start`: new index of surviving old row `i` is
  `survBefore[i]`, and a frame's new range is `[survBefore[oldStart], survBefore[oldEnd])`.
- Remaps `from_predicted` through the same table, degrading a link whose target was
  deleted to `-1` — mirroring `appendStore`'s own `outIdxOf`.
- Groups cameras by their `labels` so a **shared store** (`openProjectSlp`,
  `_sharedStore === true`) is compacted EXACTLY ONCE; unlike
  `remapTracksFromIdentity`'s `rebuiltLabels` guard (which only covers a one-time
  tracks rebuild) this guard has to cover the whole mutation, because compaction is
  global to a store.
- Then rebuilds each affected camera's `trackOccupancy` and clears both cache layers
  (`this.cache` + `labels._lazyFrameList.clearCache()`), same as
  `remapTracksFromIdentity`.
- **Caller contract:** store-only. The caller must also renumber `_rawInstIndex` on
  surviving instances in each touched (camera, frame) — else `refFor` writes grouping
  refs at the wrong instances and hydration loads the wrong 2D — and mirror the
  removal into `frameGroups`/`instanceGroups` under one shared `seen` Set.
- Unit tests: `tests/test-custom-delete-store.js` (11 cases — compaction, column-length
  coherence, typed-array kind, order-independence, emptied-frame collapse,
  `from_predicted` remap + degrade-to-`-1`, shared-store apply-once, per-row error
  isolation, no-op).

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
instance row calls `remapFn(camName, frameIdx, oldTrackIdx, offsetInFrame)` and
writes the result into `instancesData.track` in place — the same array `appendStore`
(export, `import-export/slp-streaming-write.js`) and `materializeFrame`
(re-materializing an evicted/revisited frame) both read by reference, so the
propagated track survives eviction/reload and is exported correctly with no
new writer plumbing. **`offsetInFrame`** (the row's index within its camera-frame,
the same quantity `forEachInstanceRow` reports, matching `InstanceGroup` members'
`_rawInstIndex`) lets a caller decide **per row** rather than per track — added for
luc3d #203, where a raw-trackIdx collision meant a track-keyed callback had no
answer that was right for both of the two rows sharing that trackIdx, so both were
abandoned as trackless in the first frames of a project. Existing 3-argument
callbacks (`swapTracksInStore` in `ui/identity-assignment.js`) are unaffected. Also
rebuilds THIS camera's `trackOccupancy` entry (via
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

**ROOT CAUSE of persistent wrong-frame reports, finally found (issue #115,
`eric/seeking-regression`): the vendored `MediaBunnyVideoBackend` built its
frame index in decode order, not presentation order.** Every fix below this
one (`switchSource`, the shared-cache check order, `_mbSeekLock`,
`scrubToFrame` coalescing) was real and independently verified, but none of
them explained a report of "the frame number looks correct but it pulls the
wrong video frame" on a single, deliberate, non-racing step. The actual bug
lives in the VENDORED library: `MediaBunnyVideoBackend.initialize()`
(`lib/sleap-io/chunk-X76PRJK6.js`) built `_frameTimes` by pushing
`EncodedPacketSink.packets()`'s timestamps in *iteration* order — but per
mediabunny's own docs, `packets()` yields packets in **decode** order, not
presentation order (each packet's `.timestamp` is its real PTS; only the
iteration order is unsorted). For any B-frame-encoded video — routine for
real camera recordings, and exactly what the original #115 report suspected
("keyframes versus B-frames") — decode order != presentation order, so
`_frameTimes[i]` was NOT the i-th frame in playback order: `decodeSingleFrame(i)`
looked up the WRONG timestamp for any `i` displaced by B-frame reordering,
**deterministically** returning the wrong frame's pixel content for a
correctly-requested index. This is why it reproduced identically on single
deliberate taps (no concurrency involved) and why it never showed up against
`sample_session/*.mp4` (simple test clips almost certainly encoded without
B-frames, so decode order happened to equal presentation order there,
masking the bug in every prior test). Confirmed unchanged since PR #141
(byte-identical `MediaBunnyVideoBackend` logic before and after the 0.5.5
re-vendor that only renamed the chunk) — this was a latent bug from day one
of #141, not a regression from anything touched later. Fixed by sorting
`_frameTimes` ascending by timestamp at the end of `initialize()` — see
CLAUDE.md's sleap-io.js "LOCAL PATCH (issue #115, decode-order)" entry.
Verified with a real ffmpeg-generated B-frame video (`-bf 3 -g 10`,
`tests/fixtures/bframes-test/`): 18 of 30 frames (60%) decoded wrong before
the patch, 0 after. Covered by `tests/e2e/mediabunny-bframe-decode-order.mjs`.

**`switchSource()` must refresh `_mbBackend` too (issue #115 regression,
`eric/seeking-regression`).** `switchSource(source)` — used by the pooled-
decoder session-switch/reopen path (`ui/sessions-panes.js`'s
`switchSession()`, "reuse pool decoder — swap source without creating new
video element", added to dodge Chrome browser-process crashes from repeated
`<video>` element churn) — predates the mediabunny backend and was never
updated when it landed: it closed the WebCodecs `this.decoder` but left
`_mbBackend` untouched, still bound to the PREVIOUS video. Every
frame-accurate `getFrame()` after a pooled-decoder session switch/reopen
(stepping, the `pausePlayback()` snap) then silently decoded from the wrong,
stale video — reproducing the exact pose/video misalignment #141 fixed, but
only on switch/reopen (a fresh `init()` was always fine, which is why this
was hard to pin down from a fresh-load repro). Fixed by closing the old
`_mbBackend` and re-running `_initMediabunny(source)` for the new source at
the end of `switchSource()`, mirroring `init()`'s setup. Covered by
`tests/e2e/switchsource-mediabunny-refresh.mjs` (proves it via decoded pixel
content, not just the backend's `filename`, since the fixture videos happen
to share a frame count).

**A cached HTML5 fallback permanently shadowed mediabunny for that frame
index (issue #115 followup, `eric/seeking-regression`).** `getFrame()`
checked the shared `this.cache` BEFORE trying `_mbBackend`. That cache is
ALSO written by `_getFrameHTML5` (`addToCache`) — so if a frame EVER fell
through to HTML5 for any reason (a transient decode hiccup, the brief window
before mediabunny finished initializing, the `_mbSeekLock` race described
below before it was fixed, anything at all), it got cached there
PERMANENTLY, and every future request for that exact index — even a single,
deliberate, non-racing re-visit, no stepping speed involved — returned the
stale, frame-inaccurate HTML5 bitmap forever, never retrying mediabunny
again for that one index. This was the actual root cause behind "frame
seeking is definitely pulling the wrong frame, no doubt about it" reports
that persisted even after the race-condition fixes below, and even with
single deliberate taps (no concurrency to race in the first place). Fixed
by checking `_mbBackend` FIRST — mediabunny keeps its own internal cache, so
this costs nothing once it already has the frame — and only falling through
to the shared `this.cache` (now understood to hold ONLY prior HTML5/WebCodecs
fallback results, never a mediabunny result) afterward. Covered by a unit
test in `tests/test-mediabunny-backend.js` that seeds a poisoned cache entry
via the real `addToCache` path, then proves a later request for the same
index gets mediabunny's answer once it "recovers."

**`getFrame()` serializes calls into `_mbBackend` (issue #115 followup,
`eric/seeking-regression`).** Rapid arrow-key stepping (or key auto-repeat)
fires overlapping `getFrame()` calls before the previous one resolves
(`ui/ui-wiring.js`'s arrow handler doesn't await `seekToFrame`). The
mediabunny backend's single-frame decode (`decodeSingleFrame`) has no
internal queue — only its multi-frame `decodeRange` does — so two
overlapping decodes racing the same underlying WebCodecs decoder could
return the wrong frame or fail outright for one of them, which then fell
through to the HTML5 path for that ONE frame: briefly, visibly, the
pre-#115 frame-inaccurate behavior for a single frame, "snapping back" once
the race cleared on the next step — reported as "every 3 or so frames it
goes out of sync then back in sync." `_getFrameHTML5` already had this exact
protection (`_html5SeekLock`, with a comment explaining concurrent seeks on
one element serve stale frames) but the mediabunny path never got the
equivalent lock when it was added. Fixed with a matching `_mbSeekLock`
around calls into `_mbBackend.getFrame`. Covered by two unit tests in
`tests/test-mediabunny-backend.js` (stubbed backend — proves the
serialization contract; the real WebCodecs race itself isn't reproducible
headlessly).

**Callers must coalesce rapid single-frame steps via `scrubToFrame`, never
call `seekToFrame` directly for repeatable user input (issue #115
followup-followup, `eric/seeking-regression`).** Adding `_mbSeekLock` above
made every individual `getFrame()` call correct, but every caller that
requested single-frame steps from rapid, repeatable user input — the arrow
keys and Home/End in `ui/ui-wiring.js`, `seekToLabeledFrame` (alt+arrow),
and `navigateToFrame`'s real-video branch (`pose/initialization.js`, backing
the transport Next/Prev/First/Last buttons) — called
`videoController.seekToFrame(...)` directly, with NO coalescing. Once calls
into the backend serialize, rapid presses (faster than one real decode
round-trip on a real, large video) now queue up FULLY IN ORDER instead of
racing: every intermediate frame decodes and paints before the display can
catch up to wherever the user actually is — reported as look worse than
before the serialization fix, "pulling frames in the wrong order," badly
misaligned. `scrubToFrame()` (used by the seekbar drag) already solves
exactly this class of problem — it coalesces to only the LATEST requested
target, dropping stale intermediate ones via `_scrubTarget`/`_isSeeking` —
but arrow-key/button stepping never used it. Fixed by routing all of the
above through `scrubToFrame` instead of `seekToFrame`. Covered by a new test
in `tests/test-video-controller.js` (rapid relative `"+1"` steps against an
artificially slow decoder decode fewer frames than requests) and
`tests/e2e/arrow-key-coalesced-stepping.mjs` (drives the REAL keydown
handler, proves every ArrowRight press routes through `scrubToFrame`).

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

### import-export/visibility-metadata.js

**Purpose.** The `metadata.lucid` ↔ `Session` mapping for the Visibility panel's
SESSION-SCOPED settings. One module owns the key list so a writer and a reader
cannot drift: adding a setting means touching this file and nothing else.

**What it covers, and what it deliberately does not.** The Visibility panel
holds two kinds of state:
- **Session-scoped** — per-camera video brightness / contrast / rotation and the
  timeline's hidden camera / track / identity sets. These describe *this
  project's* videos and entities, so they belong in the project file. That is
  everything this module handles.
- **Global appearance preferences** — the User / Predicted / Reprojections /
  Display Legend / 3D Viewer sliders, styles and toggles. Those are browser-local
  display taste, shared across every session, and stay in
  `localStorage.visibilitySettings` (see `ui/ui-wiring.js`). They are **not**
  written here on purpose: baking them into the `.slp` would make opening a
  colleague's project silently reassign your node sizes and 3D widgets.

**Key exports.**
- `VISIBILITY_METADATA_KEYS` — every key this module may write
  (`videoBrightness`, `videoContrast`, `videoRotation`, `hiddenCameras`,
  `hiddenTracks`, `hiddenIdentities`). Exported so tests can assert a default
  project carries none of them without duplicating the list.
- `writeVisibilityMetadata(lucid, session)` — mutate a `metadata.lucid` dict in
  place, adding only non-default settings; returns the same dict.
- `readVisibilityMetadata(session, lucid)` — read them all back onto a session.

**Three invariants the callers depend on.**
1. **Defaults are never written.** Every helper returns `null` / omits the key at
   its default, so a project nobody adjusted produces byte-identical output to
   one saved before these settings existed — pinned by
   `tests/e2e/save-golden-digest.mjs`.
2. **Only `lucid` is touched.** The writer reads nothing else off the session's
   metadata, so it cannot disturb `sessionName` / `tracks` / `frameIdentityMap` /
   `identities` / `skeleton` / `identityId` or any future sibling.
3. **Reads tolerate absence and garbage.** Every key is optional; a `.slp`
   written before this existed, or by SLEAP or another tool, simply has none of
   them and loads unchanged. Nothing here throws on a malformed payload.

Purely additive to the file format: these are optional keys inside LUCID's own
`metadata.lucid` dict, which sleap-io and sleap-io.js round-trip as opaque JSON,
so files stay readable by the SLEAP GUI.

**Imports from project modules.** `../ui/video-filters.js`,
`../ui/timeline-visibility.js` — both dependency-free leaves, so this module
bridges into the test runners without pulling `app.js` in.

**Imported by.** The four writers — `import-export/file-io.js`
(`buildSlpLabelsAllViews`), `import-export/slp-streaming-write.js`
(`buildSessionRefGraph`), and `import-export/save-load.js` (`saveProject`, both
the v2 and v3 project-JSON shapes) — and the three readers —
`import-export/slp-import.js` (`handleLoadSlpFile`), `loading/session-loader.js`
(`handleLoadProjectSlpLazy`), and `import-export/save-load.js`
(`_restoreProjectV2`).

**Tests.** `tests/test-visibility-metadata.js` (unit; bridged as
`window.__VisibilityMetadata`) and
`tests/e2e/visibility-settings-roundtrip.mjs` (real app, both writers).

---

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

**Per-camera export is STREAMED on a lazy project (`exportCameraSlpStreaming`).**
The eager builders iterate `session.frameGroups` — the RESIDENT map. That is why a
**from-scratch** project exported correctly (every frame resident, so the loop saw
the whole project) while a **reopened** one silently wrote 5,447 of 180,210
frames: same code, different residency. The fix makes the lazy path do what the
resident path does, one window at a time. `_buildCameraExportHeader`
(skeleton/tracks/video) and `_buildCameraLabeledFrame` (one camera's frame) are
now SHARED by both paths — extracted precisely so they cannot drift, since a
second implementation for the lazy path is how this divergence arose.
`exportCameraSlpStreaming` opens `SIO.openSlpWriter`, drives
`sweepLazyFrameWindows` (hydrate → build → `appendFrames` → release, 256-frame
batches), and finalizes to bytes or a sink; peak is one window regardless of
project size. Manual corrections survive because the sweep hydrates live 2D — the
case the verbatim `lazyCameraExportBytes` fast path structurally cannot handle.
Identities are deliberately NOT passed (matching `buildSlpLabels`: non-empty
`identities` bumps the format to 1.9, unreadable by sleap-io Python <= 0.6.x).
`exportSlpClientSide` and single-selection `exportSlpMultiSession` route here
whenever `_exportWouldTruncate(session)`; fully-resident projects keep the eager
path untouched. **Coverage precondition:** `sweepLazyFrameWindows` hydrates via
`batchLoadLazyFrames`, which reads the ACTIVE `state.session` — so a non-active
session in a multi-session project hydrates nothing and would emit a
resident-only file. The exporter counts frames the sweep offered against that
camera's store rows and THROWS if short, naming the numbers. Verified on the real
project: camera 21241563 exported **180,209 of 180,210 frames** (524,829
instances, 95 tracks, 203.7 MB, 75.7 s) versus 5,447 before, and the output
reopens. Multi-selection into ONE file still refuses (needs a multi-video writer
header) — see below.

**Export truncation guard (`assertExportCoversProject`).** The eager builders
(`buildSlpLabels`, `buildSlpLabelsMultiSession`, `buildSlpLabelsAllViews`,
`buildPerCameraSlpJson`, `buildSlpExportData`) all iterate `session.frameGroups`
— the RESIDENT map — so on a lazy project they write a structurally valid `.slp`
holding ~0.02% of the labels and report success. `lazyCameraExportBytes` is the
whole-project alternative, but it re-emits the columnar store VERBATIM, so it is
skipped for multi-selection exports, for reprojections-as-user, for filters that
need reprojections, and — the common case — whenever any resident frame carries a
USER correction, because the store has no notion of a live edit. Correcting
predictions being the point of the app, "correct something, then export" fell
straight through to the truncating path. `exportSlpClientSide` and
`exportSlpMultiSession` now call `assertExportCoversProject` before the eager
build and THROW (naming each session's resident/total and pointing at Save As)
rather than truncate silently. Fully-resident sessions never trip it. The proper
fix is a streaming per-camera exporter merging store predictions with the
resident user-correction overlay — the machinery `slp-streaming-write.js` already
runs for the project save, which needs a camera filter on `buildSessionRefGraph`
to be reusable here; **not yet built.** Covered by
`tests/test-lazy-export-instance-filter.js` (fully-resident correction still
exports via the eager path; partially-resident refuses and says so).

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
  **Both `buildSlpLabels` and `buildSlpLabelsMultiSession` normalize a
  null/undefined `videoFileInfo` to `{}`** instead of crashing on
  `videoFileInfo.videoPath` — found via a real Playwright test run: a lazy
  session before "Load Videos" (or a calibration-only camera) has no
  attached video file, a real reachable case, not just a test artifact
  (mirrors `slp-streaming-write.js`'s `resolveVideoPath` fallback for the
  identical scenario). Degrades to the existing `cameraName + '.mp4'` /
  zero-dimension fallback already written for a present-but-empty
  `videoFileInfo`.
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
- Misc: `downloadJSON`, `instancePointsMatch`, `instanceMatchesPoints`
  (the same comparison with a LUCID `Instance` on the left, read through the flat
  typed accessors so the SLP-load dedup passes don't allocate a boxed points array
  per candidate).

**Imports from project modules.**
- `../pose/pose-data.js` — `Camera`, `Skeleton`, `Instance`, `Identity`.
- `./slp-merge.js` — `validateSkeletonCompatibility`.
- `../pose/triangulation.js` — `getOrComputeReprojectedInstance`,
  `sweepLazyFrameWindows`.
- `./visibility-metadata.js` — `writeVisibilityMetadata` (writes the
  session-scoped Visibility settings into `metadata.lucid`; its only deps are
  two dependency-free `ui/` leaves, so it adds nothing to this module's import
  graph).

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

**Merged-save OOM: the binding constraint is V8, not WASM (luc3d #185).** A
Chrome renderer hard-caps its JS heap near 4 GB (measured `jsHeapSizeLimit`
3.76 GB headless; `--max-old-space-size` does **not** raise it, and the host's
free RAM is irrelevant). On the real 180,210-frame × 5-camera project, Track All
alone reaches **3,105 MB**, and Track All + Triangulate All leave a **2,891 MB**
pre-save baseline — so the merged save has under 900 MB of headroom. A
strip-and-GC attribution of that baseline (measured, own run at 2,877 MB):
**2,276 MB (79%)** is the live `Instance` objects pinned by
`session.instanceGroups` (see `pose/tracker.js` `commitTrackedFrame`, which
defeats `sweepTrackAllFrames`' `releaseWindow`), 411 MB (14%) `group.points3d`
as 15 boxed `[x,y,z]` per group, 132 MB (5%) `frameIdentityMap` +
`trackOccupancy` at 2,627,453 string-keyed entries, 74 MB (3%)
`group.observedPoints`. (`group.reprojections` and `state.triangulationResults`
cost ~0 on this path — `groupByIdentityAndTriangulateAll` triangulates with
`triangulateOnly`, so only 3 of 531,799 groups carry reprojections.)

`writeSessions` in the vendored writer used to allocate an estimated ~400 MB on
top of that as one boxed `Array(3)` per 3D keypoint (531,799 × 15 = 7,976,985 of
them) purely to flatten them moments later; it now accumulates into a pre-sized
`Float64Array` (~191 MB) whose backing store lives **outside** the capped heap
(`// LUCID local patch (luc3d #185)`, documented in `CLAUDE.md`, guarded by
`tests/e2e/save-session-3d-typed-sink.mjs`). Controlled A/B on the real project,
same harness and baselines within 3 MB: **unpatched → renderer crash 13 s in
(last checkpoint `after refGraph, before openProjectWriter`, i.e. inside
`writeSessions`, not `buildSessionRefGraph`); patched → 1,404,804,682 bytes
written in 49.5 s.** The h5wasm WASM heap was never the constraint (capped at
2 GiB, only ~300 MB used) — the "hard ~4 GB WASM32 ceiling" diagnosis in PR #185
is incorrect. Remaining headroom is thin, so the durable fix is still to stop
pinning live `Instance`s per grouped frame and to store `group.points3d` /
`frameIdentityMap` compactly.

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
- **`buildSessionRefGraph(session, views, videoFiles, ctx)`** — **`async`** (both
  call sites must `await`: `buildSessionSlpBytesStreaming` here and
  `commitSessionForMultiSessionSave` in `save-load.js`). PASS 1, per
  session: prunes `session.frameGroups` to user-edited frames only (frees the
  bulk of Track All's per-frame materialization before the rest of this
  function runs — note this only releases the `FrameGroup` wrappers, since every
  grouped `Instance` stays reachable via `session.instanceGroups`), builds the
  overlay plan / `storeOutIndex` / per-`InstanceGroup`
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

  Three memory measures in the ref-resolution loop, which runs once per grouped
  frame (180,210 on the real bug project) and is the PASS-1 hot path:
  - **`CamRefMap`** replaces the per-`InstanceGroup` `new Map()` for
    `instanceRefsByCamera` with a two-parallel-array container (a real `Map`
    allocates a hash table regardless of size, and there are 531,799 of these).
    It is **duck-typed against the vendored writer** — only `get`/`set`/`has`/
    `keys()`/`for...of` are implemented, which is exactly what
    `instanceGroupMemberRows` + the `InstanceGroup` constructor use as of
    sleap-io.js 0.5.5. **Re-check on every re-vendor**; a new `.size`/`.forEach`/
    `.values()`/`.entries()`/`.delete()` call would silently read `undefined`.
  - **`labeledFrameRefsByCamera` is no longer built** (it was one extra `Map`
    per frame, written and never read). Verified in the vendored writer:
    `instanceGroupMemberRows` derives `lfByCamera` only when a group carries
    CONCRETE instances (`_instanceByCamera`), which LUCID's ref-based groups
    never set, and otherwise takes the pair from `instRefs.get(camera)`.
  - **`await yieldToBrowser()` every 2,000 frames** so the save progress modal
    paints and V8 gets collection points for the loop's per-group temporaries —
    this is why the function is `async`.
  Together with the vendored `luc3d #185` typed 3D-point sink, this is the
  configuration measured as writing the real project's 1,404,804,682-byte
  merged `.slp` successfully.
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
(`import-export/file-io.js`); `points3dNodeCount` (`pose/pose-data.js`);
`writeVisibilityMetadata` (`import-export/visibility-metadata.js`, for the
session-scoped Visibility settings in `metadata.lucid` — must stay in lockstep
with the eager writer in `file-io.js`, which is why both call the one helper).
**Imported by.** `import-export/save-load.js`
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
  **Large-project size warning:** before entering the streaming path,
  `estimateLazySaveRiskBytes(sessionsToExport)` computes a rough proxy for
  PASS-1's peak JS memory (total frame x camera pairs across every lazy
  session being exported, times a bytes-per-pair constant calibrated against
  the one real measurement in this codebase's history — a 108k-frame
  x 3-camera session peaking PASS 1 at ~3.7 GB, see
  `slp-streaming-write.js`). Past `LAZY_SAVE_WARN_BYTES` (~1.5 GB, with real
  margin below that single reference point since other tab state shares the
  same budget), `window.confirm(...)` warns the user and offers to cancel in
  favor of per-camera export ("Export SLEAP File Per Session"/"By Cam", far
  less likely to crash) instead of silently attempting a merged save that's
  likely to OOM and lose all unsaved work. Declining throws
  `SaveCancelledError`, which `quickSave`/`saveProjectSlp` report as "Save
  cancelled" (not "Save failed") — `quickSave` additionally calls
  `writable.abort()` on the already-open `FileSystemWritableFileStream`
  instead of `close()`, so a cancelled save doesn't overwrite the destination
  file with zero bytes. Bypass via `opts.skipSizeWarning` on `buildSlpBytes`.
  This is a single-data-point estimate, not a calibrated model — it exists to
  warn before a likely crash, not to precisely predict one. Covered by
  `tests/test-save-load-lazy-risk.js`.
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
  `./slp-import.js`, `./visibility-metadata.js`
  (`writeVisibilityMetadata`/`readVisibilityMetadata` for the session-scoped
  Visibility settings in the legacy v2/v3 project JSON — the same keys and the
  same omit-the-defaults rule as the `.slp` writers, just at the session-dict
  level rather than under a `metadata.lucid`).

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
  the solver that produced that 3D from `ig.metadata.lucid.triangulationMethod`
  (absent = `'dlt'`), and per-session identity from `ig.metadata.lucid.identityId`
  (falling back to the raw dict's `identity_idx` for legacy files). Reads both LUCID's legacy and
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
  `../ui/sessions-panes.js`, `./visibility-metadata.js`
  (`readVisibilityMetadata`). Also spawns
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
