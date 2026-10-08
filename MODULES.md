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
**pinned to 6.6.1**, see CLAUDE.md Dependencies) are not listed under
"Imports from project modules". Neither are importmap bare specifiers
(`mediabunny`, `h5wasm`, `pako`, `yaml`); `mediabunny` is vendored in
`lib/mediabunny/` and is used for video DECODE (via sleap-io.js) and video
ENCODE (via `ui/video-encode.js`).

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
  wiring (selection, drag, double-click, edit-group, etc.). Its
  `onInstanceDeleted` — the tail of the Delete key, Edit ▸ Delete Instance and
  the toolbar's "- Instance" — calls `markDirty()`. It used not to, so a plain
  Delete left the project clean: no prompt on closing the tab, and none on a
  session switch, which evicts the session's lazy store and the delete with it.
  Pinned by `tests/e2e/sequence-lazy-workflow.mjs` cycle 5c ("every delete marked
  the project (and its session) dirty"), which failed for every path but the
  context menu before.
- `setup3DViewport()` — instantiates `Viewport3D` and wires the
  "Show Camera View"/"Show Initial View" buttons. **Respects the `\` toggle**
  (`isViewport3DVisible()`, `ui/panel-visibility.js`): it no longer clears the
  container's `collapsed` class — every session load funnels through here, so
  it used to re-open a panel the user had deliberately hidden — and when the
  panel IS collapsed it disposes the old viewport, sets the singleton to
  `null`, and returns without building a scene or a WebGL context. Releasing
  rather than keeping the previous viewport matters: leaving it alive would
  make expanding the panel show the PREVIOUS session's cameras and skeleton.
  `update3DViewport` rebuilds it from the live session on expand.
- `update3DViewport(frameIdx)` — pushes current InstanceGroups into the 3D
  scene; auto-initializes the viewport if calibration is present. Returns
  immediately when the panel is collapsed — including skipping the auto-init,
  so a hidden viewport costs no WebGL context. Nothing needs remembering: the
  rebuild is a stateless function of the current frame, and `toggle3DViewport`
  calls back in here on expand.
- `navigateToFrame(frameIdx)` — unified frame navigation used by every UI entry
  point (timeline scrub/drag, transport buttons, arrow/Home/End keys). With a
  video controller it defers to `videoController.seekToFrame`; for a video-less
  project (skeleton + imported 3D points) it clamps to `[0, totalFrames-1]`,
  updates `state.currentFrame`, and re-renders overlays + seekbar + 3D viewport
  directly so the full points3d duration is navigable without a decoder.
- `setupTimeline()` — instantiates `Timeline` and wires its frame-change /
  range-select callbacks plus the display-mode button group. The frame-change /
  drag-end callbacks fall back to `navigateToFrame` when there's no video.
- `updateFpsDisplay()` — refreshes the FPS readout, and the frame readout's
  times (`refreshReadoutTotals`), which are frame / fps.

**Imports from project modules.**
- `../ui/app-state.js` — `state`, controller singletons + setters, `VIEW_NAMES`.
- `./pose-data.js` — `Instance`, `UnlinkedInstance`, `points3dNodeCount`,
  `getPoint3d`, `groupDisplayName` (the group name in every interaction status
  line — `onInstanceConverted`, `onClonePredictedGroup`,
  `onDoubleClickReprojected`, `onInstanceDeleted`, `onAssignmentGroupCreated`.
  Never index `session.tracks` by a group's `trackIdx` (it has none) or by its
  `identityId`).
- `./triangulation.js` — `getInstanceGroupsForFrame`, `updateTimelineForFrame`,
  `reTriangulateGroup`, `sessionHasCalibration`.
- `../loading/video.js` — `OnDemandVideoDecoder`, `VideoController`.
- `../loading/session-loader.js` — `rebuildVideoController`.
- `../import-export/save-load.js` — `markDirty`, `setStatus`, `showLoading`,
  `hideLoading`.
- `../demo-data.js` — `createDemoSession`.
- `../ui/ui-wiring.js` — `setupUI`, `setupMenus`, `updateSeekbar`,
  `onPlaybackStateChange`, `fitTimelineToData`.
- `../ui/frame-readout.js` — `refreshReadoutTotals`, from `updateFpsDisplay`.
- `../ui/info-tip.js` — `installInfoTips`, called FIRST in `init()`, before any
  panel renders: the listeners are delegated, so they must be in place before
  the first `[data-infotip]` element exists.
- `../ui/info-panel.js` — `setupPanelTabs`, `setupSkeletonEditing`,
  `setupVideosTab` (the Videos tab's Load/Remove buttons, wired once here
  because `updateInfoPanel`'s no-session early return used to leave them dead on
  a fresh app — luc3d #216), `updateInfoPanel`.
- `../ui/plane-definition.js` — `setupPlaneDefinition` (called from `init()`
  right after `setupSkeletonEditing`, and **before** `paneManager.init` — its
  drop listeners are delegated on the `#videoDock` container, which is static
  markup, so panes added later are covered without re-wiring) and
  `planeInteractionCallbacks` (`Object.assign`ed onto the InteractionManager's
  callback bag in `setupInteraction`, so `ui/interaction.js` needs no import of
  the plane feature).
- `../ui/layout-controls.js` — `setupSplitHandles`.
- `../ui/rendering.js` — `drawAllOverlays`, `setReprojErrorVisible`.
- `../ui/sessions-panes.js` — `populateViewStrip`, `populateSessionStrip`.
- `../ui/identity-assignment.js` — `manualAssignState`, `getTotalUnlinkedCount`,
  `cleanupManualAssignment`, `startManualAssignment`, `editGroupState`,
  `cancelEditGroup`, `finishEditGroup`, `updateEditGroupToast`,
  `purgeTriangulationDataForGroup`.
- `../ui/overlays.js` — `getTrackColor`, `getGroupColor`.
- `../ui/viewport3d.js` — `Viewport3D`.
- `../ui/panel-visibility.js` — `isViewport3DVisible`, `markViewport3DSkipped`.
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

### pose/plane-fit.js

**Purpose.** The **one least-squares plane fit in the app**, and the symmetric
eigensolver it needs, in a module with no dependency but `pose/pose-data.js`.

**Why it exists as its own file.** `pose/plane-data.js` has to be able to fit a
plane, to enforce a `plane-locked` node's constraint in
`planeLockForNode` / `constrainPoint3dForNode` / `usablePlaneFit`. It cannot import
`pose/triangulation.js`, where both functions used to live: that module reaches
into `ui/app-state.js`, `ui/rendering.js`, `ui/info-panel.js`, `ui/settings.js`
and `import-export/save-load.js`, so importing it would drag the whole UI into a
model module whose own header promises the opposite, and every Node test that
imports `plane-data.js` with no loader hooks would stop working.
Duplicating the maths in the model was the alternative and is worse: a derived
fit has to agree EXACTLY with the one `Fit` stores, or a held corner projected
onto the derived plane moves AGAIN the next time the user clicks Fit. One
definition, two importers.

**Key exports.**
- **`fitPlaneToPoints3d(points3d)`** — total-least-squares plane through the
  centroid: the eigenvector of the SMALLEST eigenvalue of the points' 3x3
  covariance, which minimizes squared PERPENDICULAR distance. Returns
  `{centroid, normal, rms, nPoints}`, or **null** for fewer than 3 present
  points, coincident points, or COLLINEAR ones — collinear points admit a
  pencil of planes, and "fitting" to an arbitrary member of it would silently
  rotate the annotation to nonsense. The middle eigenvalue against the largest
  is what detects that. **The normal's SIGN is arbitrary** (it is a PCA
  eigenvector), which is why `pose/plane-angle.js` measures an unsigned angle
  and why the mesh exporters derive winding instead of trusting it.
- **`jacobiEigen(M, maxIter?, tol?)`** — Jacobi rotations for an NxN symmetric
  matrix, returning `{eigenvalues, eigenvectors}` (vectors as ROWS, paired by
  index, **unsorted**). Exported because the DLT solver reads it from here too:
  `pose/triangulation-core.js` imports and re-exports it rather than keeping a
  second copy, so there is ONE implementation. It was module-private before the
  split.
- **`planeIntersectionBasis(fits)`** — several planes reduced to an orthonormal
  description of what they have in common: `{dirs, offsets, used}` with
  `dirs[j]·x = offsets[j]`. Gram-Schmidt over the augmented plane equations
  `[n | d]`, which is what makes the projection below a sum of independent
  corrections instead of a linear solve and, more usefully, makes the RANK fall
  out — 1 a plane, 2 a line, 3 a point, 0 nothing. This is the geometry behind
  `PlaneModel.planeLockForNode`: a `plane-locked` node is held by every plane it
  belongs to, so what it may move in is their intersection.
  A plane that adds no independent direction is **dropped, not averaged in**,
  on a minimum-angle threshold of about 0.06° (`PLANE_INDEPENDENCE_TOL`, module
  -private): two nearly-parallel planes do intersect, in a line that runs off
  towards infinity as they line up, so fits a millimetre apart and half a degree
  out would put that line a hundred millimetres away — a worse answer than
  admitting the second plane says nothing new. Planes meant to constrain a
  corner in two directions, a floor and a wall, cross at a real angle.
- **`projectOntoPlaneIntersection(xyz, basis)`** — the nearest point to `xyz`
  satisfying every constraint in `basis`, or null if the arithmetic did not stay
  finite. Orthonormal directions mean each correction is orthogonal to the ones
  before it and cannot undo them, so this is the exact projection and
  re-projecting a point already on the subspace is a no-op. A rank-3 basis
  ignores `xyz` entirely, which is the point.

**Imports from project modules.** `./pose-data.js` — `points3dNodeCount`,
`readPoint3d`. That module imports nothing at all, so this one is importable in
Node with no stubs — which is the point.

**Imported by.** `pose/triangulation.js` (which re-exports
`fitPlaneToPoints3d` unchanged, because every existing caller and test reads it
from there), `pose/triangulation-core.js` (`jacobiEigen`, re-exported) and
`pose/plane-data.js`. Note the core is worker-loaded, so nothing heavier than
`./pose-data.js` may ever be added to this module's imports.

**Tests.** Covered through its callers: `tests/test-plane-constrained-fit.mjs`
(the unconstrained path as the constrained one's baseline),
`tests/test-plane-nodes.mjs` §20b (the derived fit) and §20c (the intersection,
including the rank-1/2/3 ladder, the fourth plane that adds nothing and the
near-duplicate that is dropped), `tests/test-plane-angle.mjs`,
`tests/e2e/define-plane-mode.mjs` (the collinear and two-point refusals) and
`tests/e2e/plane-lock-holds.mjs`.

---

### pose/plane-nodes.js

**Purpose.** The **global pool of plane nodes**. A plane node used to belong to
exactly one plane (`PlaneSkeleton` owned the node names, the colours and a flat
per-plane `points3d`), and that representation cannot express the thing the
feature is for — two planes MEETING along a shared line. Duplicated corners are
two independent 3D points that drift apart the moment either plane is
re-solved, silently splitting the annotated intersection. So nodes moved out of
the planes and into one pool; a plane became an ordered list of node
references.

**Key exports.**
- `class PlaneNode` — `id` (stable, NEVER reused), `name`, `color`, `pin`,
  `xyz` (`Float64Array(3)`, all-NaN = untriangulated, matching
  `InstanceGroup.points3d`) and `error` (mean reprojection error, px).
  `hasPoint3d()` / `getPoint3d()` / `setPoint3d(xyz, {force})` /
  `clearPoint3d({force})`. **The node's `xyz` is the single source of truth for
  a plane node's 3D** — nothing else stores one, and every writer funnels
  through `setPoint3d`, which REFUSES on a `locked` node unless forced. That
  refusal is the entire locking mechanism.
- **TWO pin states**, because "do not move this" and "do not move this OFF ITS
  PLANE" are different promises:

  | `pin` | meaning |
  |---|---|
  | `'none'` | unpinned |
  | `'plane-locked'` | may move, but only within EVERY plane it is a member of |
  | `'locked'` | the 3D is frozen outright — what the constrained-fit subsystem calls an ANCHOR |

  `plane-locked` is **not** an anchor and must never reach
  `fitPlaneConstrained`: its position is not fixed, so a fit that held it there
  would be solving the wrong problem. The two chokepoints every
  fit/triangulation consumer reads — `planeImmutableMask`
  (`ui/plane-definition.js`) and `planeNodeImmutability` (`plane-data.js`) —
  therefore report `locked` ONLY. Nor can `plane-locked` be enforced here: the
  restriction is geometric and a node cannot resolve a plane's fit — nor does
  it know which planes reference it — so `PlaneModel.planeLockForNode` /
  `constrainPoint3dForNode` own it. **The node carries no plane id.** What
  holds it is its MEMBERSHIP, so one plane leaves it a surface, two the line
  they meet in and three a single point; adding it to a plane tightens the
  constraint by itself and deleting one loosens it with no cascade. The planes
  it projects onto do NOT have to be stored `planeFit`s — see `usablePlaneFit`;
  requiring one made this pin state inert in practice, since setting the pin is
  itself what clears the fits of the planes holding it.
- `immutable` is now an **accessor** for `pin === 'locked'` (getter and setter).
  That is what kept the two-state split small: `setPoint3d`'s refusal,
  `clearPoint3d`, `mutableIds`, `nodeFreezeState` and every one of the ~30
  readers written against the original boolean work unchanged. The setter
  collapses `plane-locked` → `'none'` on `false`, which is what "unpin this
  node" has always meant.
- `nodePinState(node)` → the tri-state value; the accessor new code should read,
  since `immutable` cannot tell `plane-locked` from `none`. `normalizePin(v)`
  coerces anything (including the legacy boolean and a malformed saved value)
  into a valid state, defaulting to `'none'` rather than throwing — a malformed
  project file must load. `PIN_STATES` lists them in increasing strictness.
- `class PlaneNodePool` — the ordered pool. Its order is the canonical index
  space every `PlaneInstance` is keyed by, so it owns the operations that
  change it: `addNode(name, {color, immutable, pin})`
  (`pin` wins over `immutable` when both are given), `removeNode(id)`,
  `moveNode(from, to)` (the last two are LOW LEVEL — go through `PlaneModel`,
  which keeps the per-view 2D in step). Plus `getNode(id)`, `nodeAt(i)`,
  `indexOf(id)`, `has(id)`, `ids()`/`names()`/`colors()`, `setImmutable`,
  `setPin(id, pin)` (the only way to reach `plane-locked`, since `setImmutable`
  is a boolean and can only express the two ends; it takes NO plane, because
  membership is the constraint and there is nothing here to nominate),
  `freezeState`, `hasPoint3d`/`getPoint3d`/`setPoint3d`/`clearPoint3d` by id,
  `points3d()` (flat, pool order, freshly allocated) and `mutableIds()`.
  `adoptNode(node)` is the RESTORE-path twin of `addNode`: it takes an
  already-built node and KEEPS ITS ID, because plane membership, plane edges and
  every placement's `nodeIds` ledger are all stored as IDs — re-minting them on
  load would re-point every one of those references at whatever node landed in
  that slot. It advances `_nextId` past the adopted ID, so the pool's "IDs are
  NEVER reused" promise survives a load. Used by `pose/plane-serialization.js`.
- `nodeFreezeState(node)` → `'mutable' | 'frozen' | 'frozen-unsolved'`, keyed on
  `locked` alone (a `plane-locked` node reports `'mutable'`, because it does
  move). **It deliberately kept its three values** rather than widening to the
  new state: the return value is used verbatim as a CSS class
  (`'plane-node-' + st`) and keyed by `nodeStateTitle` and `styles.css`, so a
  fourth value would mean more edit sites for no gain.
  The flag is settable at ANY time, including before anything is triangulated —
  marking a known reference up front is reasonable and rejecting it would be
  obstructive. But a pinned node with no 3D can never ACQUIRE one, because
  being pinned is exactly what forbids a solve from writing it, so that dead
  end is NAMED rather than hidden. A constrained fit and the node table both
  need to tell the three states apart without re-deriving the condition.
- `PLANE_NODE_COLORS`, `defaultNodeColor(i)`.

**Why per-node `Float64Array(3)` and not one flat pool array.** A flat
pool-order array would have to be spliced in step with the node list on every
add/remove/reorder — exactly the index-shifting fragility this module exists to
remove. Callers that want the flat form ask for it explicitly
(`points3d()` here, `points3dForPlane()` in `plane-data.js`) and get a fresh
array in the order they asked for.

**Imports from project modules.** None (deliberately dependency-free).

**`Camera.setExtrinsics(rvec, tvec)`** replaces the extrinsics in place and
drops the memoized `rotationMatrix` / `extrinsicMatrix` / `projectionMatrix`.
Those three memoize on first read and there is no other way to invalidate them,
so assigning `rvec`/`tvec` directly leaves a camera that REPORTS its new pose
and PROJECTS with its old one — a divergence nothing would flag. It mutates
rather than replacing the object on purpose: callers all over the app hold
`Camera` references obtained by name lookup, and swapping in a new instance
would leave some of them on the old extrinsics. Written for
`pose/origin-rebase.js`; pinned by `tests/test-origin-rebase.mjs` §7.

**Imported by.** `pose/plane-data.js` (which re-exports all of it),
`pose/plane-serialization.js`.

**Tests.** `tests/test-plane-nodes.mjs`,
`tests/test-plane-serialization.mjs` (the `adoptNode` restore path).

---

### pose/plane-data.js

**Purpose.** Data model for user-annotated **planes** — step 1 of re-defining
the 3D viewer's origin (the end goal being a translation vector + rotation
matrix that move the world frame onto an annotated plane). Owns the types
annotation produces and nothing about the solve or the UI, which live in
`pose/triangulation.js` and `ui/plane-definition.js`.

**Key exports.**
- `class PlaneSkeleton` — one plane: `nodeIds[]` (an ORDERED LIST OF NODE
  REFERENCES into the pool), `edges` as pairs of **NODE IDS**, `name`, `color`,
  `filled`, `triangulation` (`{views, nNodes, meanError}`) and `planeFit`
  (`{centroid, normal, rms, nPoints}` — **the object a later step turns into
  the translation + rotation that re-defines the origin**). Membership and
  edges are IDs, never index pairs: an index pair breaks the instant the pool
  shifts or a node is shared. `size`, `hasNode`/`indexOfNode`/`addNode(id)`/
  `removeNode(id)` (which drops the edges through it)/`moveNode`,
  `addEdge`/`hasEdge`/`removeEdge`/`removeEdgeBetween`, `clearTriangulation()`.
  **Deliberately NOT a `Skeleton` subclass any more** — `Skeleton` models nodes
  it OWNS (`addNode(name)` mints one, `removeNode(idx)` renumbers edges by
  index), both actively wrong for references into a shared pool.
  **`clearTriangulation()` drops `planeFit` + `triangulation` and NOTHING
  ELSE.** It cannot reach a node's 3D — the plane holds no reference to the
  pool. That asymmetry is the point: it is called on every 2D edit, placement
  change and node-list change, so if it could still null 3D, a pinned node's
  surveyed coordinate would evaporate the first time the user nudged an
  unrelated corner in an unrelated view.
- `class PlaneInstance extends Instance` — **one per VIEW**, covering the whole
  pool (index = pool index), not one per (view, plane). `ui/interaction.js`
  drags a plane node through the SAME `hasPoint`/`getX`/`getY`/`setPoint`/
  `numNodes` path it drags a UserInstance through, and one instance per view
  keeps that a single implementation. Carries `id`, `viewName`,
  `type: 'plane'`, `nulledNodes` (Set of POOL INDICES; same field name and
  meaning as a UserInstance's, so the inherited `hasAnyUsablePoint()` already
  reads it), **`derivedNodes`** (Set of POOL INDICES whose 2D here was
  REPROJECTED from the 3D rather than annotated — see below), `placedPlanes`
  (Set of PLANE IDS — explicit, because with shared nodes "this node has a
  position here" can no longer tell you which planes the user placed) and
  **`nodeIds`** (the NODE ID of each column). Frame-independent by design.
  - `nodeIds` is a LEDGER, not a second addressing scheme: callers still address
    the instance by POOL INDEX through the inherited accessors. It exists
    because **a count is not an identity.** An instance can be DETACHED from the
    model (per-session placement maps), and while detached the pool can have a
    node spliced out of the MIDDLE or moved. Re-syncing such a map by node COUNT
    re-seats every column past the edit onto its neighbour's node — silently,
    with every point still looking valid. Matching by ID is the only repair that
    can tell those cases apart.
  - `isNodeNulled(i)` / `toggleNodeNull(i)` / `isPlanePlaced(planeId)`,
    `centroid(indices?)` (restrict to one plane's nodes for its label).
  - `isNodeDerived(i)` / `setNodeDerived(i, on)` / `clearDerivedNodes(indices?)`
    — the REPROJECTED flag. `triangulatePlane` reprojects a solved plane into the
    views it is not placed on so the user can see (and correct) where it lands
    there; such a point is exactly the projection of the current 3D, so it is not
    evidence. Feeding it back would add no information while dragging the
    reported reprojection error toward zero — a quality readout that improves
    every time you press the button. So a derived point renders and drags like
    any other, but is excluded from the solve and from the error average until
    the user DRAGS it, which clears the flag. Deliberately separate from
    `nulledNodes`: "turned off" and "never placed" are different facts, and a
    right-click-off must not silently promote a reprojection to an annotation.
  - `_indexFlagSets()` — every index-keyed flag set (`nulledNodes`,
    `derivedNodes`) in one list, which the three index-remapping paths
    (`resyncToNodeIds` / `removeNodeAt` / `moveNodeAt`) all iterate. A set left
    un-remapped points at its NEIGHBOUR's node and every point still looks
    valid — the aliasing failure class this whole model was rebuilt to avoid — so
    add a new per-(view, node) set here and remapping follows for free.
  - `appendNode(id)` — one unpositioned column. New slots are left UNPOSITIONED,
    unlike the per-plane model: a node only becomes visible on a view once a
    plane referencing it is placed there, and that is where seeding happens.
  - `resyncToNodeIds(ids)` — re-seat the columns onto `ids` BY NODE ID; a
    survivor keeps its point and its per-node flags (nulled, derived) wherever it
    moved to, a dropped
    node's column goes, a new node arrives unpositioned. The repair path for a
    detached map, and what `attachPlacements` / `ensureInstance` use.
  - `seedNodeNear(idx, cx, cy, ordinal, videoW, videoH)` — golden-angle spoke,
    for a node joining an ALREADY-placed plane (an unpositioned node draws
    nothing, so there would be nothing to grab).
  - `removeNodeAt(i)` / `moveNodeAt(from, to)` — mirror the pool's splice/move,
    carrying the per-node flag sets with their nodes.
- `class PlaneModel` — pool + planes + `placements` (`Map<viewName,
  PlaneInstance>`) + `meshObjects` (a `MeshObjectSet`, see
  `pose/mesh-object-3d.js` — purely ADDITIVE: no method here reads or maintains
  it, and `deletePlane` deliberately does NOT cascade into it, because membership
  resolves lazily), and every operation that spans them. Doing any of these
  piecemeal corrupts the index space: `createPlane`/`getPlane`/`deletePlane`
  (**deletes NO nodes — every one survives**),
  `adoptPlane(plane)` (the restore-path twin of `createPlane`, keeping the
  plane's ID because `PlaneInstance.placedPlanes` stores plane IDs — see
  `PlaneNodePool.adoptNode`),
  `planesForNode(id)`, `planeLockForNode(nodeId)`,
  `constrainPoint3dForNode(nodeId, xyz)`, `usableFitForPlane(planeOrId)`,
  `ensureInstance`/`getInstance`/`views`/`allInstances`,
  `attachPlacements(map)` (adopt a session-owned map, re-syncing every instance
  to the pool and pruning placement flags for deleted planes),
  `addNode`/`deleteNode`/`moveNode` (pool + every view's 2D + every plane's
  membership and edges), `addNodeToPlane`/`createNodeInPlane`/
  `removeNodeFromPlane`, `placePlane`/`unplacePlane`/`isPlanePlaced`/
  `placedViews`/`placedPlanes`, `isNodeVisibleOn`/`visibleNodeIndices`/
  `planeNodeIndices`, `invalidateNode3D(id)` and `invalidatePlane3D(plane)`.
- **Deleting a plane deletes no nodes, ever.** Nodes are plane-independent now,
  so a node no plane references is still a valid pool member the Nodes table
  lists, and the user's only instrument for removing one is an explicit
  `deleteNode`. Auto-deleting "orphans" would destroy exactly the nodes worth
  keeping — a pinned surveyed reference, a corner staged for a plane not built
  yet — as a side effect of an unrelated action, and deletion is the one path
  no re-fit can undo. `removeNodeFromPlane` follows the same rule
  (`deleteIfOrphan` defaults to FALSE, opt-in for a caller that has actually
  confirmed the intent).
- **`planeLockForNode(nodeId)`** answers what a `plane-locked` node may move
  in: `{rank, planes, basis}`, where `rank` is how many directions it is pinned
  in — **0** free, **1** a plane's surface, **2** the line two planes meet in,
  **3** the single point three meet at, which is a lock in all but name — and
  `planes` is every plane holding it that has a usable fit. The planes are its
  MEMBERSHIP (`planesForNode`), never a nominated id: a node added to a wall is
  held by that wall from the next call, a plane deleted stops holding anything
  with no cascade, and there is no second record of "which plane" that could
  disagree with the planes the node is actually in. Each plane contributes a
  USABLE fit with the node EXCLUDED (`usablePlaneFit`), so no plane can be
  derived from the very point being moved; the geometry is
  `planeIntersectionBasis` in `pose/plane-fit.js`, which also decides which
  planes are independent enough to count.
- **`constrainPoint3dForNode(nodeId, xyz)`** is the SINGLE place the
  `plane-locked` pin state is honoured: the point comes back as the NEAREST
  position satisfying every plane the node belongs to
  (`projectOntoPlaneIntersection`), so an edit that already satisfies them is
  taken verbatim and re-applying the constraint to a committed position is a
  no-op. A node that is not `plane-locked`, or that nothing can currently hold,
  passes through untouched. It cannot live on `PlaneNode` (where `locked` is
  enforced, in `setPoint3d`) because the constraint is geometric and a node can
  neither resolve a plane's fit nor find the planes referencing it.
- **`usablePlaneFit(plane, pool, excludeNodeId?)`** / **
  `PlaneModel.usableFitForPlane(planeOrId)`** — the plane to project onto: the
  stored `planeFit`, else one derived with `fitPlaneToPoints3d` from the plane's
  own solved corners, writing nothing. **Requiring a STORED fit is what made
  `plane-locked` do nothing at all**, and the loop is worth stating: `setNodePin`
  (`ui/plane-definition.js`) clears the `planeFit` of every plane holding the node
  whose pin just changed — including the planes it is being held in — so
  plane-locking a node's last act was to remove the planes it was being locked
  to. On a real five-plane cage, four planes had no stored fit and typing
  `z = 2000` into the held corner left it 683 mm off its plane with nothing
  saying so.
  **`excludeNodeId` is not an optimisation.** A derived fit is least-squares
  through the points it is handed, so including the node being constrained lets
  the plane CHASE it: the projection lands between the typed point and the real
  plane, and every repeat edit drifts further (measured 647 mm out on that same
  project). Excluding it makes the plane the OTHER corners define — which is what
  "keep this corner in the plane" means — and makes re-projecting a committed
  position a no-op. A STORED fit is used unexcluded, because it does not move
  when a corner is nudged. Fewer than 3 other solved corners, or collinear ones,
  derive nothing and the constraint stays inert: two corners admit a pencil of
  planes and choosing one would silently invent geometry.
  `ui/plane-angle.js`'s `usableFit` now delegates here, so the dialog and the pin
  cannot disagree about where a plane is.
- **`force` never rides a cascade.** `setPoint3d`/`clearPoint3d`'s `force` means
  one narrow thing — explicit user re-entry of a pinned coordinate. Invalidation
  fires off edits made somewhere else entirely, so it does NOT forward its
  options to the leaf: `invalidateNode3D` / `invalidatePlane3D` take the
  separately named `forceClearImmutable`, and a stray `{force:true}` in their
  options cannot strip a pinned node.
- Per-plane materializers, all freshly allocated (the pool stays the single
  source of truth): `points3dForPlane(plane, pool)` → flat `Float64Array(3n)`
  in PLANE order, all-NaN triple for a node with no 3D — the shape the 3D
  viewport payload, the fit and the origin frame already read;
  `writePoints3dForPlane(plane, pool, flat, {force, constrain})` →
  `{written, skippedIds, constrainedIds}` (the ONLY way a solve should publish;
  it SKIPS `locked` nodes and says which, so a writer cannot quietly undo the
  constraint it solved under). The optional `constrain(nodeId, xyz) → xyz` hook
  is threaded HERE rather than at each call site precisely because this is the
  one sanctioned publish path — every solve (triangulate, fit, the angle edit)
  therefore honours a `plane-locked` node without any of them having to
  remember to. Callers holding a model pass `constrainPoint3dForNode`; callers
  that do not (the pure tests) pass nothing and get the old behaviour exactly;
  `nodeErrorsForPlane`, `planeNodes`/`planeNodeNames`/`planeNodeColors`/
  `planeNodeImmutability` (parallel to `planeNodeColors`; a corner shared
  between two planes reads pinned in BOTH, which is what lets a frozen shared
  node hold an intersection line still while either plane is re-fitted. It
  reports `locked` ONLY — a `plane-locked` node is not an anchor, and feeding it
  to `fitPlaneConstrained` as one would hold fixed a point whose position is not
  fixed) /
  `planeNodeIndices`, `planeEdgesLocal` (plane-order index pairs, for the 3D
  payload) / `planeEdgesPoolIndices` (for the 2D overlay + interaction hit
  test), `planeCentroid2d(plane, pool, instance)`.
- `planeCycleOrderIds(plane)` — the RING the user drew, as node IDs, or `null`
  when their connections do not form one. A ring is a single simple cycle
  covering every node the plane references (every node at degree exactly 2, one
  closed walk); an open chain, a partial or disjoint cycle, a branch, or no
  edges at all returns null, because those state an outline only partially and
  guessing the rest is how a fill self-intersects. Purely topological, so it is
  the ONLY form that can express a **concave** outline (an L-shaped floor) — the
  user's edges say so explicitly, and nothing may second-guess them.
- `planePolygonOrderIds(plane)` — the ring when there is one, else MEMBERSHIP
  order, as node IDs; `planePolygonOrder(plane)` (plane-local indices) and
  `planePolygonOrderPoolIndices(plane, pool)` are its two index views. The
  coordinate-free answer, kept for callers that want it — **the fill does not
  use these** (see below).
- `convexHullOrder2d(pts)` / `convexHullOrder3d(qs, normal?)` — hull of a point
  set as indices into it, in ring order. Andrew's monotone chain; interior
  points, points on a hull edge, and duplicates are dropped, so the result is
  the outline and nothing else. Fewer than 3 hull vertices (coincident or
  collinear input) returns the input order unchanged, so a caller's own `< 3`
  guard reads the way it always did. The 3D form projects onto an in-plane basis
  first — `normal` (a `planeFit`'s) fixes it, otherwise one is estimated from
  the two longest independent directions in the set; that only ever decides
  vertex ORDER, never a coordinate.
- `planeFillOrderPoolIndices(plane, pool, instance)` (2D, pool indices) /
  `planeFillOrder3d(plane, pool)` (3D, plane-local indices) — **what the fill
  actually walks.** The user's ring when they drew one, otherwise the CONVEX
  HULL of the plane's points. Two things this fixes over membership order: a
  quad whose corners were not added in ring order fills as a self-intersecting
  bowtie, and — the reason the hull fallback exists — a node placed in the
  MIDDLE of a plane is necessarily a REFLEX vertex in membership order, so the
  fill carves a notch in to it instead of covering it. Under the hull the
  outline is the outermost nodes and an interior node sits INSIDE the fill.
  Hulling per VIEW in 2D rather than once in 3D is deliberate: the fill is a 2D
  silhouette of that view's points, which exist before anything is triangulated.
  Unpositioned nodes contribute no vertex; a node with 2D but no 3D is a vertex
  of the 2D fill and not the 3D one.
- `seedPlanePoints(n, cx, cy, videoW, videoH)` — node 0 at 12 o'clock, the rest
  evenly around a ring of `PLACEMENT_RADIUS_FRAC` (12%) of the video's shorter
  side, clamped into the frame. A 4-node plane lands as a recognisable quad to
  drag onto the real feature, not a pile of coincident dots.
- `PLANE_COLORS`, `PLACEMENT_RADIUS_FRAC`, and everything re-exported from
  `pose/plane-nodes.js`.

**Nodes are plane-independent.** A plane REFERENCES nodes; it does not own
them. The same node may belong to any number of planes, which is what lets two
planes meet along a shared line — the corners on it are ONE node with ONE 3D
position, so the line cannot split when either plane is re-triangulated.
`planeFit` stays per-plane because two planes through the same edge genuinely
have different fits; the triangulated POINTS are what is shared.

**Placement membership is explicit; un-placing keeps 2D.** Visibility is
derived from `placedPlanes` (`isNodeVisibleOn`), so nothing consults the points
to decide what to draw and there is no reference counting to get wrong.
Un-placing a plane from a view therefore does NOT destroy 2D — re-placing
restores exactly what the user positioned, and `placePlane` seeds only the
nodes that have no position yet. Deleting a NODE is what destroys 2D,
everywhere at once.

**Isolation.** PlaneInstances live on `PlaneModel.placements`, NOT in
`frameGroups` / `instanceGroups`. Nothing in the existing pose pipeline can
see them, so `type: 'plane'` never has to be handled by code that switches on
user/predicted/reprojected.

**Imports from project modules.** `./pose-data.js` — `Instance`;
`./plane-nodes.js` — the pool (re-exported); `./mesh-object-3d.js`;
`./plane-fit.js` — `fitPlaneToPoints3d` for `usablePlaneFit`, plus
`planeIntersectionBasis` / `projectOntoPlaneIntersection` for
`planeLockForNode`. Still DOM-free and still off `pose/triangulation.js`, which
is the whole reason the fit lives in its own module.

**Imported by.** `ui/plane-definition.js`, `ui/plane-angle.js`,
`pose/plane-serialization.js`, `pose/plane-angle.js`.

**Tests.** `tests/test-plane-nodes.mjs` (§20/§20b/§20c for the pin constraint,
the derived fit with the exclusion's negative control, and the
membership-intersection ladder),
`tests/test-plane-serialization.mjs`, `tests/e2e/define-plane-mode.mjs`,
`tests/e2e/plane-lock-holds.mjs`.

---

### pose/plane-serialization.js

**Purpose.** The Define Planes feature's **on-disk form, both ways** — the node
pool, the planes (membership, edges, fill, the solve summary, the plane fit),
the per-view 2D and the origin frame, to plain JSON and back. Owns the mapping
and NOTHING about where the bytes end up; `import-export/plane-metadata.js`
decides that. DOM-free and UI-free so the round trip is directly testable, which
matters more here than usual: a subtly wrong restore does not crash, it hands
back a plane whose corners sit on their NEIGHBOURS' nodes with every point still
looking perfectly valid.

**The scope split it encodes.** PROJECT-scoped: the pool, the planes, the origin
frame — one node has one 3D position for the whole project, which is the entire
reason the pool is global. SESSION-scoped: the `PlaneInstance` per view, because
a view belongs to a session (stored on `Session.planePlacements`).

**Key exports.**
- `serializePlaneNodes(pool)` / `restorePlaneNodes(data)` — pool order is
  preserved because it IS the index space every `PlaneInstance` is keyed by. A
  node with no 3D **omits `xyz` entirely** rather than writing three numbers:
  `JSON.stringify(NaN)` is `null`, so a naive round trip returns
  `[null, null, null]` and every `isFinite` check downstream has to defend
  against it. A locked node's coordinate is restored with `{force: true}` —
  being locked is exactly what refuses an ordinary write. Entries with a missing
  or DUPLICATE id are skipped, never renumbered.
- **The two pin states, written so BOTH directions degrade correctly.** A
  `locked` node writes `pin: 'locked'` **and**, redundantly, `immutable: true`,
  so a build predating the split still freezes it — that key is the only thing
  such a build reads. A `plane-locked` node writes `pin` alone and deliberately
  **no** `immutable`, because an older build cannot enforce "stays in its
  planes" and reading it as a hard freeze would be strictly wrong; treating it
  as free is the honest fallback. **No plane id rides along**: the pin holds a
  node in every plane it is a member of, and membership is already in the file
  under `planes`. A `pinPlaneId` written by an earlier build named one of those
  planes, so it is read and DISCARDED rather than adopted — keeping it would
  resurrect a second source of truth about the same thing. On restore `pin`
  wins when
  present, and a legacy record's `immutable: true` means `locked`, which is what
  it has always meant. Both go through `normalizePin`, so an unrecognized value
  loads as unpinned rather than refusing the file. An unpinned node writes
  NEITHER key, per the format's rule that defaults are never written — which is
  why `tests/e2e/save-golden-digest.mjs` does not move, and why
  `PLANE_METADATA_KEYS` does not change: this rides the existing `planeNodes`
  key and needs no version bump.
- `serializePlanes(planes)` / `restorePlanes(data, pool)` — includes `filled`,
  `triangulation` and `planeFit`, because those are the plane's STATE, not a
  cache: a reopened plane that came back un-fit would offer Set Origin no
  corners and report no error, so the user would have to re-solve to get back
  what they saved. References to nodes the pool does not hold are **dropped**
  (the plane comes back one corner short, which is visible) rather than kept
  dangling (a -1 index reads whatever sits at the end of the points array —
  a corner in a plausible but wrong place, which is not).
- `serializeMeshObjects(set)` / `restoreMeshObjects(data, planeIds)` — the named
  groups of planes. Membership is written VERBATIM, **including IDs whose plane
  has since been deleted**: membership resolves lazily everywhere else, so
  scrubbing on the write side would be the one place that quietly decides a plane
  is gone forever. The READ side drops unresolvable IDs instead, at the point
  where the live plane set is actually known — which is why `restorePlaneProject`
  restores objects LAST, after the planes they filter against are installed.
  An object writes exactly `id`/`name`/`color`/`planeIds` — there is NO
  orientation key, because winding is derived. A `flipNormals` left in a file by
  an older build is read and DISCARDED rather than adopted: re-applying a stale
  override would invert exactly the objects the derivation already gets right.
- `serializePlanePlacements(placements, pool)` / `restorePlanePlacements(data,
  pool, planeIds)` — points are written as `{n: <nodeId>, xy, off, derived}`,
  **not** as a dense pool-order array. A dense array can only be re-seated by
  COUNTING, and counting is exactly the repair that cannot tell "a node was
  appended" from "a node was spliced out of the middle": every column past the
  edit comes back on its neighbour's node, still looking like a good point. A
  view holding no positioned point and no placed plane contributes nothing.
- `serializeOriginFrame(frame)` / `restoreOriginFrame(data)` — writes only the
  **two things the user chose** (the origin and the +Z, plus the
  `sourcePlane`/`sourceNode` labels, which cannot be re-derived once a plane is
  renamed). `R`, the translation and the axis-angle form are derived
  deterministically by `buildOriginFrame`, so storing them too would create a
  second source of truth that a file edit or a version bump could put at odds
  with the inputs. The rebuild is exact.
- `serializePlaneProject(model)` / `restorePlaneProject(model, data)` — the
  project-scoped bundle: pool + planes + mesh objects. `restore` **REPLACES** all
  three rather than merging: two projects' node IDs are unrelated, so a merge
  would either collide IDs or renumber them, and renumbering is the one thing
  this module must never do. (Replacing all three in one call is also what makes
  `resetPlaneState()` a single call as the model grows.) A plane the user named
  but has not populated still round-trips, as does an object named before it was
  populated; only a model with no nodes, no planes AND no objects serializes to
  `null`.

**Absence is a value.** Every serializer returns `null` when there is nothing to
say, so a project that never opened the feature writes no keys and its bytes are
unchanged (`tests/e2e/save-golden-digest.mjs`). Every reader tolerates absent,
malformed and partial input — a `.slp` from SLEAP, or from a LUCID build older
than this module, restores an empty model rather than throwing.

**Imports from project modules.** `./plane-nodes.js` — `PlaneNode`,
`PlaneNodePool`; `./plane-data.js` — `PlaneSkeleton`, `PlaneInstance`;
`./origin-frame.js` — `buildOriginFrame`.

**Imported by.** `import-export/plane-metadata.js`.

**Tests.** `tests/test-plane-serialization.mjs` (ESM, 74 assertions — identity
after the trip, the NaN case, a pool that CHANGED between save and load, garbage
tolerance, the origin rebuild), `tests/e2e/plane-persistence-roundtrip.mjs`
(the same claims through the real app and a real `.slp`).

---

### pose/origin-frame.js

**Purpose.** The **payload of the whole Define Planes feature**: turns "this
annotated corner is the origin, and +Z points that way" into the translation +
rotation that re-express the calibration's world frame in the user's frame.
Everything upstream (plane skeletons, placements, triangulation, plane fit, 3D
corner dragging) exists to produce this function's two inputs. DOM-free and
dependency-free, so it is directly testable and callable from a future save
path.

**Convention, stated once and used everywhere:**

    p_new = R · p_old + t,    t = −R · origin

`R`'s **rows** are the new frame's axes in old-world coordinates. `t` is the
mapping's translation, **not** the origin's position — both are reported and
both are labelled in the UI, because confusing them silently flips a sign. The
inverse is `p_old = Rᵀ · p_new + origin`.

**Key exports.**
- `buildOriginFrame(origin, zAxis, xHint)` → `{origin, xAxis, yAxis, zAxis, R,
  translation, rotationVector, axis, angleRad, angleDeg}` or **null**. Z is the
  user's choice; X and Y are not, so they are derived deterministically — old
  world +X projected onto the plane (Gram-Schmidt), falling back to old +Y when
  Z is within ~26° of X and the projection is ill-conditioned; `Y = Z × X`. That
  fixes the roll about Z arbitrarily but **consistently**: the same two clicks
  must not produce a different rotation twice. `xHint` is the hook for a later
  step that wants a meaningful X (a plane edge, say) — it belongs here rather
  than as a re-derivation elsewhere. Returns null on non-finite input or a
  zero-length Z rather than inventing a frame.
- `rotationMatrixToAxisAngle(R)` → `{axis, angleRad}`. Handles the two cases the
  generic formula divides by zero on: angle ≈ 0 (returns +X and 0, so the
  rotation vector is exactly the zero vector) and angle ≈ π (recovered from
  `R + I = 2nnᵀ`, taking the largest diagonal column for conditioning). **The π
  case is not exotic here** — it is what picking the "blue" arrow produces.
- `rotationAboutAxis(axis, angleRad)` → row-major 3×3, or **null** for a
  zero-length or non-finite axis. Rodrigues, `R = I + sin t·K + (1 − cos t)·K²`,
  written out in closed form rather than as two matrix products so it is exactly
  orthonormal for a unit axis. **The exact inverse of
  `rotationMatrixToAxisAngle`**, which is why it lives here: the two are tested
  against each other, so neither can drift from this module's convention alone.
  The same formula also appears inline in `Camera.rotationMatrix`
  (`pose/pose-data.js`), which bakes the angle into an OpenCV-style `rvec`'s
  magnitude; that one is coupled to the class and is deliberately left alone.
- `mulMat3Vec3(R, v)` → `R · v`, no translation — what rotating a DIRECTION (a
  plane normal) needs, as against `applyOriginFrame`, which is an affine map of
  a POINT. Confusing the two is how a rotated normal picks up a translation.
- `applyOriginFrame(frame, p)` / `unapplyOriginFrame(frame, q)`.
- `rebaseExtrinsics(camR, camT, frame)` → `{R, rvec, tvec}` or **null** — the
  **calibration half of the origin change**. Applying an origin deliberately
  moves nothing in the data (see `ui/origin-definition.js`), which leaves the
  calibration as the one artifact still speaking the old frame; a downstream
  tool handed the user's 3D and the ORIGINAL `calibration.toml` would reproject
  against the wrong world. From `p_cam = R_cam·p_old + t_cam` and
  `p_old = Rᵀ·p_new + origin`: `R_new = R_cam·Rᵀ`,
  `t_new = R_cam·origin + t_cam`. **The translation is built from
  `frame.origin`, not `frame.translation`** — the two differ by a rotation, and
  substituting one produces a calibration that still almost works, which is the
  worst kind of wrong. Intrinsics and distortion are not its business. Returns
  both notations because the TOML writer matches the source file's shape.
- `normalize3` / `cross3` / `dot3`.

**Imports from project modules.** None, deliberately.

**Imported by.** `ui/origin-definition.js`, `pose/origin-rebase.js`
(`rebaseExtrinsics` + the point/direction transforms), `pose/plane-serialization.js`
(which persists an applied frame as its two INPUTS — the origin and the chosen
+Z — and rebuilds everything else through `buildOriginFrame` on load, so the
derived `R` / translation / axis-angle can never contradict them),
`pose/mesh-object-geometry.js` (`applyOriginFrame` only) and
`pose/plane-angle.js` (the rotation primitive plus the vector helpers).

**Tests.** `tests/test-origin-frame.mjs` (ESM — the numerical branches the
wizard rarely reaches: 180°, the near-parallel X fallback, rigidity,
round-trip, degenerate refusals, §9 the `rotationAboutAxis` ↔
`rotationMatrixToAxisAngle` round trip over five axes × five angles, asserting
orthonormality and `det = +1` at each, and §10 `rebaseExtrinsics` — pinned by
the one invariant that matters, that a point lands on the same camera
coordinates via (old extrinsics, old point) and (new extrinsics, re-based
point), plus a negative control that substituting `frame.translation` for
`frame.origin` gives a different answer) and `tests/e2e/define-plane-mode.mjs`
§14 end to end.

---

### pose/origin-rebase.js

**Purpose.** Move the **whole project** into the defined origin — the engine
behind the Danger Zone's `Set as New Calibration`. `ui/origin-definition.js`
applies an origin to what is DRAWN and to nothing else, deliberately; this
module is the other choice, taken explicitly, and rewrites every stored 3D
number so the project IS that frame.

**Three transforms, and they must all happen together:**

| thing | rule |
|---|---|
| 3D point | `p' = R·p + t` (affine) |
| 3D direction (a plane normal) | `n' = R·n` — **no translation** |
| camera | `R_cam' = R_cam·Rᵀ`, `t_cam' = R_cam·origin + t_cam` |

Do all three and **every 2D pixel is unchanged**: a point's reprojection under
the new calibration lands exactly where it landed under the old one. That
invariant is the whole safety argument, and it is what both test files assert
first. Move the points without the cameras (or vice versa) and every
reprojection error in the project silently explodes. So the set is not
negotiable: `InstanceGroup.points3d` across every session it is handed, the
plane node pool, each plane's stored fit, and every camera. 2D data — member
instances, reprojected instances, plane placements — is invariant and is not
touched.

**The `sessions` argument is the SUBSET the user chose**, and that is the whole
mechanism — no function here takes a "which sessions" flag, so there is no
partial code path to drift out of step. On a multi-session project the
confirmation dialog carries a checkbox per session (`ui/origin-rebase.js`) and
hands in the filtered array; a session that is not in it keeps BOTH its 3D and
its cameras, so it stays internally consistent while the project as a whole
ends up holding 3D in two frames. The plane pool and the plane fits are
project-scoped and move exactly once, with the active session — which the
dialog does not allow to be deselected.

**Key exports.**
- `countRebaseTargets(sessions, model)` → the tally the confirmation dialog
  lists. **`tally.points3d` is every 3D point that moves — `keypoints3d` PLUS
  `planeNodes`** — and it is what the dialog's headline quotes. A plane node is
  a 3D point: same calibration world, same rewrite in `applyOriginRebase`.
  Quoting `keypoints3d` alone under a heading that says "3D points" told a user
  with planes and no pose annotation that nothing would be updated, one row
  above the nine plane nodes about to move. A plane FIT stays out of the sum —
  it is a centroid and a normal, not a point.
  Groups are bucketed by their MEMBERS' types (`user` / `predicted` /
  neither), because `points3d` itself carries no provenance — LUCID writes one
  `Instance3D` per group either way. Each bucket is counted **both ways**:
  `userGroups` / `predictedGroups` / `untypedGroups` (how many groups) and
  `userKeypoints3d` / `predictedKeypoints3d` / `untypedKeypoints3d` (how many
  points they hold), so the dialog can put points under a points heading and
  keep the group count in the label. `reprojectedInstances` is reported and
  labelled **unchanged**, because it is not work.
  **`userInstances` / `predictedInstances` are the WHOLE 2D population**, not
  the grouped half: most of what an imported `.slp` carries is ungrouped
  predictions, which `restoreGroupingAndUnlink` parks in
  `FrameGroup.unlinkedInstances`, and counting only group members reported
  **0 predicted instances** on a project holding hundreds of thousands. The
  enumeration mirrors `ui/custom-delete-ops.js`'s `collectSessionWide`:
  `lazyLoader.forEachInstanceRow` (duck-typed, no import) on a lazy project,
  because `session.frameGroups` there is a small resident window; group members
  plus the unlinked pool on an eager one, which are disjoint by construction.
  `instanceScope` (`'store'` / `'resident'`) says which answered, and
  `userMembers` / `predictedMembers` keep the grouped subtotal.
  **`perSession` is the same record once per session**, holding only what is
  session-scoped: cameras, pose 3D, the 2D population, `planePoints2d`. The
  plane pool and the plane fits are project-scoped (one shared `PlaneModel`)
  and appear only in the totals — splitting them per session would invent a
  division the data does not have. Every per-session field sums to its total,
  which `tests/test-origin-rebase.mjs` §1d asserts field by field.
  `planePoints2d` is the planes' own 2D, counted in POINTS so it shares a unit
  with the pose 2D beside it in the dialog.
- `subsetRebaseTally(full, keep)` → the same tally re-totalled over a SUBSET of
  its sessions, `keep(perSessionRecord, index)` choosing them. The confirmation
  dialog's headline numbers have to follow its session checkboxes, and
  re-running `countRebaseTargets` on the filtered array — which is what the
  COMMIT does — re-walks the 2D inventory, i.e. a pass over a lazy project's
  whole columnar store per click. Every session-scoped number is already in
  `full.perSession`, so this is a re-FOLD rather than a re-count: it shares one
  private `foldPerSessionTotals` with `countRebaseTargets`, so a re-fold and a
  fresh count of the same sessions are the same tally by construction (pinned
  field-for-field by `tests/test-origin-rebase.mjs` §11). `planeNodes` /
  `planeFits` are carried over VERBATIM — project-scoped, moving once, with the
  active session.
- `planOriginRebase(sessions, model, frame, opts)` → a plan, `null` when
  cancelled or the frame is unusable, or `{failed, camera}` when one camera
  cannot be re-based (which abandons the WHOLE plan — a project with one camera
  left in the old frame is worse than one that did not move). **Writes
  nothing:** it builds the replacement buffers beside the live ones, so
  cancelling is free and exact. Yields every `opts.yieldEvery` (default 2,000)
  units and asks `opts.shouldCancel()` there.
- `applyOriginRebase(plan)` → swaps them in, synchronously. Plane nodes are
  written straight to `node.xyz`, **bypassing `PlaneNode.setPoint3d`'s refusal
  for a Locked node**: a pin says "do not re-solve this point", not "exempt this
  point from the world moving".

**Why copy-on-write rather than transform-in-place-and-invert.** The second
would halve the peak (~175 MB on a 7.3M-point project, in typed arrays outside
V8's cage — the cheap place for it) but `Rᵀ(R·p + t − t)` is not bit-identical
to `p`, so a *cancelled* operation would leave every coordinate perturbed in its
last few ULPs.

**It is an O(groups) in-memory walk even on a lazily-reopened project.**
`session.instanceGroups` is built in full at load by BOTH reconstructors in
`import-export/slp-import.js` — it is the grouping + 3D, and only the 2D
`frameGroups` are windowed. So there is no hydration sweep here and no
resident-only hazard (#194/#195): nothing this module reads can be absent.

**Imports from project modules.** `./origin-frame.js` (`applyOriginFrame`,
`mulMat3Vec3`, `rebaseExtrinsics`), `./pose-data.js` (`pooledPoints3d` — `applyOriginRebase` stores each re-based group in the slab pool — `points3dNodeCount`,
`hasPoint3d`). DOM-free.

**Imported by.** `ui/origin-rebase.js`.

**Tests.** `tests/test-origin-rebase.mjs` (ESM — over a real `PlaneModel` and
real `Camera`s: the pixel invariant with an un-rewritten-calibration negative
control, that planning writes nothing, that a cancel is byte-identical, NaN
preservation, the Locked node moving anyway, the centroid/normal split with a
negative control, camera cache invalidation, the 3x3-notation case, and §11
the SUBSET case — a re-fold equalling a fresh count field for field, and an
omitted session's 3D *and* cameras coming out bit-identical while the chosen
one's move, with a negative control that the same point DOES move when its
session is included) and `tests/e2e/set-new-calibration.mjs`.

---

### pose/calibration-compare.js

**Purpose.** Do the sessions of a multi-session project agree about where the
world is? A multi-session load reads ONE CALIBRATION PER SESSION FOLDER and
nothing makes them match, so this module answers the question and, when the
answer is no, says which of two very different things went wrong.

**The two disagreements, which need opposite advice.**
- **Same rig, different origin.** `Set as New Calibration` re-bases every
  session in memory but writes ONE file, and `pickCalibrationFile` then PREFERS
  that file on the next load — so one session comes back re-based while the rest
  come back in the original frame. Recoverable by moving a file.
- **Genuinely calibrated apart.** A rig moved, or a camera was re-focused
  between recordings. No file move helps; those sessions' 3D simply is not in a
  shared space.

**Telling them apart is a MEASUREMENT, not a guess.** For one physical camera
described by two calibrations A and B, a world point obeys
`x = R_A*p_A + t_A` and `x = R_B*p_B + t_B`, so if the two worlds are related at
all they are related by `p_A = R_f*p_B + t_f`, giving

    R_f = R_A^T * R_B        t_f = R_A^T * (t_B - t_A)

per camera. If EVERY camera agrees on `(R_f, t_f)` the two calibrations differ
only by where the origin is, and `t_f` is literally the position of B's origin in
A's coordinates — the number worth quoting to the user. If they disagree, no
single frame change explains them. On the real `small_multi_session` folder the
eight cameras agree to 3e-14 in rotation and 5e-13 mm in translation, which is
why `FRAME_ROT_SPREAD` / `FRAME_TRANS_SPREAD` can be loose (1e-6, 1e-3 mm) and
still decide the question.

**Key exports.** `compareSessionCalibrations(sessions)` — groups the sessions by
identical calibration, takes the LARGEST group as the reference (earliest on a
tie, so the wording is stable across reloads) and describes every other group
against it. Each difference gets a `kind`:
- `'cameras'` — a different camera SET, with `onlyHere` / `onlyInReference` names.
- `'lens'` — intrinsics, distortion or image size differ, in `lensCameras`. An
  origin change never touches these, so this alone rules out the recoverable case.
- `'origin'` — one rigid transform explains every camera. Carries `frame` with
  `origin`, `distanceMm`, `angleDeg`, `axis` and the measured `spreadRot` /
  `spreadTransMm`.
- `'extrinsics'` — the cameras moved and no single origin explains them.
`report.frameOnly` is true only when EVERY difference is `'origin'`; that one
flag is what selects which advice the modal prints.

**Three deliberate details.** A session with NO cameras is excluded from the
comparison and listed in `withoutCalibration` rather than counted as a third
calibration — a per-camera folder load with no `.toml` would otherwise raise the
modal on a perfectly consistent project. A camera whose rotation or translation
will not read (NaN, wrong length) is DROPPED, so one malformed entry cannot
masquerade as a divergence. And only cameras whose LENS matches contribute to the
frame solve: a re-focused camera's extrinsics are not a statement about the origin.

**Imports from project modules.** `./origin-frame.js` (`rotationAboutAxis`,
`rotationMatrixToAxisAngle`, `normalize3`) — the rotation maths it would
otherwise duplicate; `rotationAboutAxis` IS Rodrigues with the angle separated
out, so an `rvec` converts by handing it the vector and its own magnitude. No
other imports and DOM-free, so the comparison is unit-testable under Node.

**Imported by.** `ui/calibration-notice.js`.

**Tests.** `tests/test-calibration-compare.mjs` (ESM, 51 assertions — the
re-based fixtures are built with the app's own `buildOriginFrame` +
`rebaseExtrinsics`, so the detector and the re-base cannot drift apart silently;
plus a pure translation, a pure rotation, a matrix-form `rvec`, all four `kind`s,
a 1 nm negative control, an even split, and a NaN camera) and
`tests/e2e/multi-session-calibration-notice.mjs` (the real calibrations off disk).

---

### pose/plane-angle.js

**Purpose.** Set the ANGLE BETWEEN two annotated planes. Every plane's
`planeFit` is fitted independently through its own triangulated corners, so
nothing makes two planes that are perpendicular in the real world come out
perpendicular in the model — a floor and a wall land a degree or two off, and
that error is then baked into everything derived from them (a mesh object's
geometry, an exported cage, an origin frame taken from one of them). This
module lets the user ASSERT the relationship instead: hold one plane fixed and
rotate the other rigidly until the angle is met.

DOM-free and THREE-free. It imports **only** `origin-frame.js` and
`plane-data.js`, and deliberately **not** `triangulation.js` — not even for
`planesInvalidatedByFit`, whose question `PlaneModel.planesForNode` answers from
the other side — because triangulation.js pulls in DOM and three.js UI modules,
and a test would then need the loader stubs `tests/test-plane-constrained-fit.mjs`
has to install. Being importable with no stubs is most of this module's value.

**Hence the optional `fits` argument** on `hingeAxis` and `planAngleEdit`. A
plane can hold 3D for every corner and still carry no stored `planeFit` —
pinning a node clears the fit of every plane standing on it, and a plane that
was triangulated but never Fitted never had one. Such a plane is perfectly
measurable; it just needs a fit computed. That used to be on the other side of
this import line; `fitPlaneToPoints3d` now lives in the stub-free
`pose/plane-fit.js`, so the argument survives as a **test seam** rather than a
necessity — `tests/test-plane-angle.mjs` feeds it hand-written fits, including
all four normal-sign combinations, which no derivation would hand it. The caller
derives the real one (`ui/plane-angle.js` > `usableFit`, now the model's
`usablePlaneFit`) and passes it in, and everything here treats a derived fit and
a stored one identically — `newMovingFit` is the rotation of whichever it got.

**The angle is UNSIGNED, and that is not a simplification.**
`fitPlaneToPoints3d` takes the smallest-eigenvalue eigenvector straight from
`jacobiEigen` and never stabilizes its sign (only the CONSTRAINED path calls
`orientNormalLike`). A signed dihedral angle read off two stored normals is
therefore not reproducible — it is θ or 180 − θ depending on round-off in two
unrelated fits. The measurement is `acos(|n_f · n_m|)` ∈ [0°, 90°], invariant
under flipping either normal, which is also exactly what a user means by "the
angle between these planes". `tests/test-plane-angle.mjs` §7 asserts all four
sign combinations move the points to the same place.

**The axis is the SHARED EDGE.** Two planes that meet share their corner nodes
— one `PlaneNode`, one `xyz`, referenced by both — so the line through them is
the natural hinge: rotating about it leaves every shared corner exactly where it
was, the planes stay joined, and the fixed plane is not disturbed at all.

| shared, triangulated nodes | axis | `kind` |
|---|---|---|
| 2 or more | the line through the two farthest apart | `'edge'` |
| exactly 1 | through it, along `n_fixed × n_moving` | `'node'` |
| none | through the moving plane's centroid, same direction | `'centroid'` |

`n_fixed × n_moving` is the direction the planes' intersection line runs, so the
fallbacks turn about the direction the shared edge would have had; parallel
normals leave it undetermined and any perpendicular is used (a local `anyPerp`,
matching triangulation.js's own local copy).

**Key exports.**
- `planeAngleDeg(nA, nB)` → degrees in [0, 90], or null. 0 = parallel,
  90 = perpendicular.
- `sharedNodeIds(planeA, planeB)` → the membership intersection in `planeA`'s
  order. There is no existing helper — the model only answers the inverse
  question (`planesForNode`) — and membership is a short `number[]` of IDs, so a
  filter is both the clearest and the fastest thing.
- `hingeAxis(fixedPlane, movingPlane, pool, fits?)` → `{point, dir, kind,
  sharedIds, hingeIds}` or null. `hingeIds` are the corners ON the axis, and so the ones
  guaranteed not to move.
- `sharedNodesSpanAPlane(ids, pool)` — three or more shared corners off a line
  mean the planes already share a PLANE, and no rotation can change their angle
  without moving the fixed plane too. That is `overconstrained`, refused rather
  than approximated.
- `solveAngleRotation(nFixed, nMoving, axisDir, targetDeg)` → radians or null.
  Rotating `m` about `u` traces a sinusoid in the dot product with `f`:
  `A + B cos φ + C sin φ` with `A = (m·u)(u·f)`, `B = m_⊥·f`,
  `C = (u × m_⊥)·f`. So `|(R·m)·f| = cos target` is `A + K cos(φ − δ) = ±T`,
  solved in closed form — two signs × two arccos branches, up to four
  candidates, and **the smallest |φ| is returned**. That is what keeps a wall
  tilting the way it already leans rather than flipping through the floor, and
  it is the single most load-bearing line in the module (a mutation to `>`
  reddens 20 assertions). The result is then re-measured and rejected if it
  misses the target, so a wrong branch fails loudly. `K ≈ 0` means the moving
  normal lies along the hinge, where rotating cannot change the angle at all.
- `applyRotationToPoints3d(flat, R, pivot, nodeIds, fixedIds)` → a NEW
  `Float64Array`; missing nodes stay missing. `fixedIds` are copied through
  verbatim: points on the axis are fixed mathematically, but only to within
  round-off, and a shared corner drifting by an ulp is exactly the silent
  divergence the shared node pool exists to prevent.
- `rotatePlaneFit(fit, R, pivot)` — the same rigid motion applied to a stored
  fit. **Rotating rather than re-fitting is deliberate:** a re-fit re-derives
  the normal's sign from `jacobiEigen` and can flip it, which changes nothing
  geometrically but silently inverts anything downstream that read the old sign.
  `rms` / `nPoints` are properties of the annotation and ride through unchanged,
  as does `constrained` when present (dropping it is a bug
  `serializePlaneFit` already has, and is not worth repeating).
- `planAngleEdit(fixedPlane, movingPlane, targetDeg, model, fits?)` → a plan, mirroring
  `planPlaneFit`. **PURE — it reads the model and writes nothing**, which is
  what lets the UI preview it, refuse it, or be cancelled with nothing to undo,
  and which is its own test. Refusal codes: `no_model`, `no_plane`,
  `same_plane`, `no_fit`, `bad_target`, `degenerate_axis`, `overconstrained`,
  `unreachable`, and `locked_nodes`.
- `ANGLE_TOL_DEG`, `HINGE_MIN_LEN`, `COLLINEAR_TOL_FRAC`, `NAME_LIST_CAP`.

**Every warning NAMES what it counts.** A count on its own ("2 other planes")
tells the user nothing they can act on, so each `warnings[]` entry spells out
the things it is about:
- `plane_locked_elsewhere` lists `node (in "plane", …)` per held node — the
  node FIRST, the planes holding it elsewhere second. The old wording put a bare
  node list in parentheses right after "another plane", which read as if the
  parenthetical named the plane. "Elsewhere" is MEMBERSHIP: the pin nominates no
  plane, so a corner this rotation shares with a wall is pulled back onto that
  wall, while a corner whose only plane is the moving one rides along and is not
  reported.
- `stale_fits` lists `"plane" (shares node, …)` — both which fit is about to be
  cleared and which moved corner costs it. The shared node is the one the user
  would have to un-share to avoid the loss.
- Both are capped at `NAME_LIST_CAP` (3) names inline with a `+N more` tail,
  because the angle dialog is a narrow floating panel; each carries the
  untruncated list in a `detail` string, which `ui/plane-angle.js` hangs off the
  warning line as a `title` tooltip. Singular/plural is exact in both.
`stalePlaneIds` is unchanged in meaning and shape — the commit path keys off it.

**Pin states decide who may move.** A `locked` node the rotation would move is a
hard refusal (`locked_nodes`, naming the nodes) — the user pinned that
coordinate and the angle cannot be honoured with it. Nodes on the HINGE are
excluded from that check because they do not move: locking a shared corner is
the documented way to hold an intersection line still, so it must not block the
very edit it enables. `plane-locked` nodes are allowed: a rigid rotation of the
whole plane keeps them in that plane by construction. One held in a DIFFERENT
plane is allowed but warned about, since the commit projects it back and the
result may then miss the target.

**Imports from project modules.** `./origin-frame.js`, `./plane-data.js`.

**Imported by.** `ui/plane-angle.js`.

**Tests.** `tests/test-plane-angle.mjs` (ESM, 188 assertions over a
floor-and-wall fixture whose angle is analytic — §10 and §12 pin the warning
wording, so a warning that stops naming its nodes fails) and
`tests/e2e/plane-angle.mjs` (the real app; §6b asserts the rendered warning text
and its tooltip).

---

### pose/mesh-object-3d.js

**Purpose.** The **grouping layer**: a *3D Mesh Object* is a named set of
PLANES, the way a plane is a named set of nodes. It completes the three-level
model — a node is a point with one 3D position, a plane is a group of nodes, and
an object is a group of planes **whose shape is determined by how those planes
are connected**. Nothing here is geometric; `mesh-object-geometry.js` derives the
shape on demand.

The class is `MeshObject3D` because a JS identifier may not begin with a digit.
**Every user-facing string says "3D Mesh Object"** — the table header, the
buttons, the status messages. Know that before renaming anything.

**Key exports.**
- `class MeshObject3D` — `id` (stable, never reused), `name`, `color` and
  `planeIds` (ordered; insertion order is the face order an export will use).
  Deliberately NO orientation field: winding is derived in
  `pose/mesh-object-geometry.js`, so a stored override could only ever be a
  second source of truth for it. `hasPlane` / `addPlane` / `removePlane`,
  `resolvePlaneIds(model)` / `resolvePlanes(model)` / `planeCount(model)` /
  `danglingCount(model)`.
- `class MeshObjectSet` — `objects`, `size`, `isEmpty`, `createObject(name, {color})`,
  `adoptObject(obj)` (RESTORE path — keeps the file's ID and advances `_nextId`,
  exactly as `PlaneNodePool.adoptNode` does and for the same reason),
  `getObject(id)`, `deleteObject`, `renameObject` (refuses a blank name),
  `recolorObject`, `objectsForPlane(planeId)`, `clear()`.
- `MESH_OBJECT_COLORS`, `defaultMeshObjectColor(i)` — a palette deliberately
  disjoint from `PLANE_COLORS` and `PLANE_NODE_COLORS`, because an object's
  colour overrides its members' when drawn and the two must be tellable apart.

**Why membership resolves LAZILY, and why there is no delete cascade.** Every
read of membership filters against the live planes (`resolvePlaneIds`). So
`PlaneModel.deletePlane` does not know objects exist, needs no hook, and cannot
leave an object holding a dangling reference — the reference is simply never
dereferenced except through the filter. This is the single design choice that
makes the whole feature **additive**: no method that predates it changes
behaviour. The cost is that `planeIds.length` is NOT the face count; call
`planeCount(model)`.

**Imports from project modules.** None (deliberately dependency-free; the
`PlaneModel` references are JSDoc types only).

**Imported by.** `pose/plane-data.js` (which owns a `MeshObjectSet` as
`PlaneModel.meshObjects` and re-exports these symbols),
`pose/plane-serialization.js`, `ui/mesh-objects.js`.

**Tests.** `tests/test-mesh-object-3d.mjs` (51 assertions — identity, adoption,
membership order, and §4 the additivity guarantee: a plane model with objects on
it is byte-identical to one without, including after deleting a member plane).

---

### pose/mesh-object-geometry.js

**Purpose.** Turn "a group of planes" into a **mesh**, derived and never stored.
The shape is a pure function of the plane model, rebuilt whenever anyone asks —
the same rule `ui/viewport3d.js` follows when it rebuilds `_planeGroup` every
update. A stored mesh is a second copy of every vertex that goes stale the moment
a node is dragged, re-triangulated or pinned.

**How connectivity determines the shape.** All three fall out of the global node
pool, and none of it needs a merge-by-distance pass:
1. **Vertices** are the pool nodes the member planes reference — two planes
   referencing one node produce ONE vertex, so a shared corner welds itself.
2. **Faces** are the planes, each a ring of vertex indices.
3. **Edges** are shared automatically: an edge is an unordered pair of vertices,
   and two faces are adjacent iff they list the same pair. That adjacency graph
   IS "how the planes are connected"; shells, naked edges, manifoldness and
   coherent winding are all read off it.

**Key exports.**
- `buildMeshObjectGeometry(obj, model, {frame, scale, eps})` → `MeshObjectGeometry`:
  `vertices` (`Float64Array`, 3V), `vertexNodeIds` (V, provenance), `faces`
  (polygon rings), `facePlaneIds`, `faceNormals` (3F, unit, coherent),
  `triangles` (`Uint32Array`, ear-clipped) and `connectivity` (`vertices`,
  `faces`, `shells`, `edgeCount`, `nakedEdges`, `nonManifoldEdges`, `isClosed`,
  `isOriented`, `degenerateFaces`, `stalledFaces`, `danglingPlaneIds`,
  `coincident`, `volume`).
- `faceRingNodeIds(plane, pool)` — the same dispatch `planeFillOrder3d` uses
  (user edge cycle, else convex hull seeded by `planeFit.normal`) but in NODE
  IDS, which is the only index space two different planes share.
- `faceAdjacency`, `orientFacesCoherently`, `meshConnectivity`, `signedVolume`,
  `areaVectorZ`, `earClip2d`, `earClipFace`, `newellNormal`,
  `coincidentNodeReport`, `connectivitySummary`.

**Winding is the part the annotation does not determine.** A face's ring
ultimately depends on `planeFit.normal`, a PCA eigenvector whose SIGN IS
ARBITRARY, so independently-fit planes have unrelated windings — black patches
and failed booleans downstream. `orientFacesCoherently` fixes the relative half
by BFS over the adjacency graph using the manifold rule (**two faces sharing an
edge traverse it in OPPOSITE directions**). The global half is then ONE BIT,
and there is a rule for each topology:

- **CLOSED** — `signedVolume`. Negative ⇒ flip all ⇒ outward.
- **OPEN** — no enclosed volume, so the convention is **+Z is up**:
  `areaVectorZ` (the Z of `Σ (b−a) × (c−a)`, i.e. the area-weighted vertical
  component of the normal field) must come out non-negative. For a cage that
  means **the floor faces up**, because a vertical wall's area vector is
  horizontal and contributes nothing — the floor alone decides. Coherent winding
  then couples the rest, so the walls end up on their INWARD faces, the surfaces
  enclosing the arena. Unlike `signedVolume` this is origin-INDEPENDENT, which
  is what makes it legitimate on an open surface, and the axis is that of the
  frame the vertices are already in (so with an origin defined, "up" is the
  user's up — the same frame the exporters write). Only an all-vertical surface
  has no vertical component to read; `UPRIGHT_EPS` (relative to
  `surfaceAreaScale`, so it means the same at any unit scale) catches that and
  leaves the orientation alone.

This replaced a real coin flip: the open default used to fall out of the PCA
sign of whichever ring happened to be first, so the same cage exported either
way depending on the order its planes were created in.
`tests/test-mesh-object-geometry.mjs` §3b feeds one cage in four ring
orders/windings and demands one answer — it was confirmed to FAIL on the
previous build (one arrangement gave `n.z = −1`).

**There is no user override, and the panel has no `Flip normals` control.** The
derivation answers every case it could: `signedVolume` when the mesh is closed,
+Z-up when it is open. The one shape with no defined answer — an all-vertical
open surface — is left exactly as the coherent pass produced it, which is
STABLE across rebuilds; the test asserts that rather than asserting a direction,
since `areaVectorZ` is ~0 there and reading a sign off it would flip the object
on floating-point noise.

**Ear clipping, not the viewport's fan.** `viewport3d._buildPlaneFillMesh` fans
over the ring, which is right for a translucent overlay and self-overlaps on any
concave face. `earClipFace` projects onto the face's own 2D basis and clips
there. Its point-in-triangle test is deliberately **non-strict**: a vertex lying
exactly ON a candidate ear's edge must block it, or the ear is clipped and the
triangle pokes outside the polygon — a plain L-shaped ring hits this.

**Coordinates.** LUCID's world is Z-up right-handed and **so is Blender's** — no
axis conversion belongs anywhere in this pipeline. The only transforms applied
are the user's origin frame (`applyOriginFrame`) and a uniform positive scale
(non-positive is ignored rather than allowed to mirror the mesh).

**Imports from project modules.** `./plane-data.js` — `planeCycleOrderIds`,
`convexHullOrder3d`; `./origin-frame.js` — `applyOriginFrame`. DOM-free and
THREE-free.

**Imported by.** `ui/mesh-objects.js`.

**Tests.** `tests/test-mesh-object-geometry.mjs` (86 assertions — a unit cube
from six deliberately-inconsistent rings welding to 8 vertices and enclosing +1,
an open cage, shell counting, ear clipping against a fan negative control,
coincident-node detection, frame + scale). Its coherence negative control checks
the **opposite-traversal property directly** rather than comparing volumes,
because signed volume is taken about the world origin and any face through the
origin contributes zero however it is wound — a unit cube at `[0,1]³` measures
+1 even with half its rings backwards.

---

### pose/pose-data.js

**`InstanceGroup.points3d` on the bulk paths lives in a slab pool.**
`pooledPoints3d(points)` copies a group's flat 3D into a 1 MB slab and returns a
`Float64Array` VIEW of exactly its 3N doubles (`isPooledPoints3d` tells them
apart); an already-pooled array comes back unchanged, null/empty pass through,
boxed rows are normalized first (`asPoints3d`), and anything over a sixteenth of
a slab keeps its own buffer. Every bulk writer stores through it: Triangulate
All (`_applyGroupStep`, pose/triangulation.js; `applyIdentitySolve` and
Group by Track, ui/export-modals.js), Track All (`commitTrackedFrame`,
pose/tracker.js — which also stops the group sharing the tracker target's live
array), reopen and the other import paths (import-export/slp-import.js; the JSON
project loader in save-load.js), the origin re-base (`applyOriginRebase`) and
`moveVideosToSession`. Single-frame solves keep their own buffers (bounded). A
view behaves like an owned array for everything `points3d` is used for —
indexing, in-place writes (they stay in its own region), `length`, `slice()`,
`new Float64Array(view)`, `ArrayBuffer.isView` — but must never be TRANSFERRED
or re-wrapped through `.buffer` (that is the whole slab; a `postMessage` of one
would also copy it). Nothing does either. Why: 539,545 groups owned 539,545
ArrayBuffers after Triangulate All on the 8-camera, 108,000-frame project, and
every full GC sweeps every ArrayBuffer. Dead regions of re-solved groups pin
their slab until its last view goes — a Triangulate All replaces every group, so
old slabs die whole. Covered by `tests/test-points3d-pool.mjs` and
`tests/e2e/sequence-lazy-workflow.mjs` (`checkPooled`).

**`InstanceGroup.reprojectedInstances` starts as the shared
`NO_REPROJECTED_INSTANCES`**, an empty read-only Map (a subclass whose `set`
throws); `addReprojectedInstance` gives the group a Map of its own on its first
write. Reading, iterating, `clear()` and `delete()` behave as on any empty Map,
and replacing the whole Map by assignment is fine. After Track All + Triangulate
All on the 8-camera, 108,000-frame project, 539,545 groups each owned an empty
Map (a JSMap plus its hash table) and held 40 entries between them. Writers must
go through `addReprojectedInstance`, test fixtures included — a direct `.set` on
the shared Map throws rather than leaking an entry into every group.

**`frameIdentityMap` is a `FrameIdentityMap`.** A packed key is above V8's
small-integer range for every frame past 127, so in a plain Map every entry
cost a heap Number — 4,147,806 after Track All on the 8-camera, 108,000-frame
project, plus a multi-million-slot hash table, all marked or scanned by every
full GC — measured at ~29 ms of a ~195 ms full GC and 103 MB of V8 heap
(`_bench-playback.mjs HEAPPROBE=1`, #282).
`FrameIdentityMap extends Map` and overrides every method: numeric keys and
values live in `Float64Array`s in insertion order, with an open-addressing
`Int32Array` index; other keys (the legacy `"frame:cam:null"` strings, NaN) and
non-number values go to small side Maps. Map semantics are kept exactly —
insertion order (load-bearing: `exportFrameIdentityEntries` writes in it, so the
saved bytes depend on it), `set` on an existing key keeping its place,
SameValueZero keys, live iteration (deleted-before-reached skipped, added
visited, `clear()` ends it). One difference: deleted entries are holes until the
arrays next grow, and if most are dead they are COMPACTED instead — an iterator
open across a compaction throws rather than skip or repeat silently. `Session`
exposes `frameIdentityMap` through an accessor that converts any plain Map
assigned to it (keeping order), so `deleteTrackAt`'s and Track All's
`= new Map()` still end up compact; `propagateIdentitiesToTracks` builds its new
map and its two transient packed-key maps as `FrameIdentityMap`s directly. It
must not be structured-cloned or posted to a worker (its Map slot is empty);
nothing does. Covered by `tests/test-frame-identity-map.mjs` — 60,000 random
operations in lockstep with a real Map, compared in full order.

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

**The shared lazy placeholder.** `lazyPlaceholderXY(numNodes)` returns ONE
NaN-filled `Float64Array(2n)` per node count, and `isLazyPlaceholderXY(xy)`
recognises it by identity. Every lazy `InstanceGroup` member whose 2D lives only
in the store points at it: a reopened project's placeholders
(`reconstructInstanceGroupsFromSessionLazy`) and members whose frame went
non-resident (`releaseFrameMembers2d`, `pose/lazy-residency.js`). A private
buffer each was 1.39 GB and ~4.2M ArrayBuffers after a Track All on the 8-camera
108,000-frame project. **It is never written:** the three IN-PLACE writers —
`setPoint`, `clearPoint` and `setPointVisible`'s restore — call the private
`_ownXY()` first, which swaps in a copy when `_xy` is the placeholder. Writers
that assign a new array (`setPointsFrom`, `adoptPointsFrom`, `restorePoints`,
`insertNodeAt`/`removeNodeAt`) need no guard. A NEW in-place writer must call
`_ownXY()`, or one edit moves every lightweight member in the project.

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
- `groupDisplayName(session, group, frameIdx)` — the name a status line gives an
  `InstanceGroup`, never `undefined`/`null`. A group has **no `trackIdx`** (its
  member instances do, and a member's can be `null` since luc3d #273), and
  `identityId` is an identity id, not an index into `session.tracks` — reading
  either as a track index printed "Converted Track undefined to user instance".
  Resolved in `getGroupColor`'s order: the per-frame identity of a member's own
  (camera, trackIdx) at `frameIdx`, then `group.identityId` via `getIdentity`,
  then the first member's track name (`'Track N'` for an unnamed index, as the
  2D labels do), then `'group'`. Only a non-negative integer `trackIdx` counts as
  a track (a pre-#273 `-1` is trackless). Used by the five group-naming status
  lines in `pose/initialization.js`. Tested by `tests/test-group-display-name.mjs`.
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
  `tests/e2e/identity-switch-propagates-to-end.mjs`. It is
  `swapIdentitiesInRange(startFrame, Infinity, …)`;
  `swapIdentitiesInRange(startFrame, endFrame, identityA, identityB)` — the same
  swap bounded on BOTH sides (inclusive), what fixing a flagged ID switch does
  (`ui/id-switch-modal.js`): the frames after the pair's switch-back are already
  right. Its own inverse, which is how a fix is undone. Covered by
  `tests/test-id-switch-fix.mjs` §3;
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

**Track All closes the Timeline and the 3D viewer.** On success, a full Track
All calls `collapseTimeline()` (`ui/timeline-controller.js`) and
`collapseViewport3D(viewport3d)` (`ui/panel-visibility.js`) so the views showing
the new IDs get the space back — there is no 3D pose to look at until Triangulate
All runs. A closed panel stays closed. Track Frame Range and Track Frame leave
both as they were. Covered by `tests/e2e/track-all-closes-timeline-and-3d.mjs`.

**Track All ends on a summary box.** After the automatic ID-switch checks,
`runTrackingPass` (Track All only — a range is a targeted re-run inspected on the
timeline) opens `showTrackSummaryModal` (`ui/track-summary-modal.js`) with
`summarizeTrackedIdentities` and one `describeSwitchCheck` per cue
(`ui/track-summary.js`). It reports how long tracking took — `trackStart` is taken
AFTER the animal-count prompt, so the user's typing is not counted, and stops when
the identity pass returns — with its speed (fps, and × real time from the
recording rate `state.fps`, falling back to `session.fps`, as the ID-switch checks
read it), and each check's own `elapsedMs` (stamped by `runIdSwitchChecks`). It exists because a check that found nothing used to end the
run with no visible next step. The summary is wrapped in its own `try`: tracking
has already succeeded, so a summary failure only logs. Covered by
`tests/e2e/track-all-summary.mjs`.

**Every tracking pass marks the project dirty.** Track Frame, Track Frame Range
and Track All rewrite `session.instanceGroups`, `session.frameIdentityMap` and
`session.identities`, so each calls `markDirty()` — `trackCurrentFrame` before it
drops the frame's groups, `runTrackingPass` before `clearIdSwitchResults` and its
own clear, so both sweeps (`runCrossViewTrackerProgress` and the windowed
`sweepTrackAllFrames`) are covered by the one call. For a long time none did:
after Track All on a fresh project the save dot and `• Lucid` title never
appeared and closing the tab lost the result without a prompt. The call sits
AFTER every bail-out (a refused click is not an edit) and is deliberately NOT
conditional on what the run found: the clear runs first, so a re-run that
matches nothing — or throws partway — has still wiped the previous result, and
gating on `numTargets`/`numIdentities` would leave exactly that unflagged. Same
placement rule as `triangulateAllFrames`. Covered by
`tests/e2e/track-marks-dirty.mjs` (all three entry points, eager and windowed,
the zero-match re-run, and the bail-outs as negative controls), the Track All
step of `tests/e2e/sequence-lazy-workflow.mjs` and `tests/test-tracker-gui.mjs`.
Those tests switch the automatic ID-switch checks off, because a check that runs
calls `markDirty()` itself and would hide a tracker that never does.

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
- `./pose-data.js` — `InstanceGroup`, `points3dNodeCount`, `hasPoint3d`,
  `readPoint3d`, `pooledPoints3d` (`commitTrackedFrame` stores a COPY of the
  target's 3D in the slab pool — one ArrayBuffer per group was 539,545 for a
  full Track All, and the group no longer shares the target's live array).
- `./triangulation.js` — `computeFundamentalMatrix`, `triangulatePointDLT`,
  `triangulatePoints`, `reprojectPoint`, `reprojectPoints`,
  `computeInstanceDistance`, `hungarianAlgorithm`.
- `../ui/app-state.js` — `state`, `interactionManager`, `timeline`,
  `viewport3d`, `getActiveSession`.
- `../ui/settings.js` — `getNodeWeightArray`, `getTrackingThresholds`,
  `getTrackingThreshold`, `isCameraTracked` (both `trackAll`/`trackCurrentFrame`
  drop cameras where `isCameraTracked(name)` is false before tracking; abort with
  a warning if fewer than 2 views remain included).
- `../import-export/save-load.js` — `markDirty` (every tracking pass, once its
  bail-outs are behind it — see above), `setStatus`, `hideLoading`.
- `../ui/loading-overlay.js` — `showLoadingProgress`, `createProgressPacer`,
  `yieldToPaint`.
- `../ui/rendering.js` — `drawAllOverlays`, `showPredictedOnly`,
  `PREDICTED_ONLY_NOTE`: Track Frame (when it found targets), Track Frame Range
  and Track All (when they assigned identities) end showing ONLY the Predicted
  layer — User, Reprojections, Errors unticked — and append the note to the status line
  when that changed anything (the tracking counterpart of Triangulate All's
  Reproj-only switch, #243).
- `../ui/info-panel.js` — `updateInfoPanel`.
- `../ui/id-switch-modal.js` — `runIdSwitchChecks`, `clearIdSwitchResults`: after a successful Track
  All or Track Frame Range that assigned 2+ identities, `runTrackingPass` runs the
  ID-switch checks over the whole session (`{auto: true, statusPrefix, size,
  image}`: size per the Tracking Wizard's `autoSwitchCheck` (default on), images
  per `autoImageSwitchCheck` (default off)) and awaits them, so the pass resolves
  after the checks. It also drops the session's earlier results and their
  markers (`clearIdSwitchResults(session)`) before clearing identities, for both paths.
  Its return value (each result carries `elapsedMs`) feeds the Track All summary.
- `../ui/track-summary.js` — `summarizeTrackedIdentities`, `describeSwitchCheck`
  (the Track All summary's data).
- `../ui/track-summary-modal.js` — `showTrackSummaryModal`: opened at the end of a
  successful Track All (see above).
- `../ui/timeline-controller.js` — `collapseTimeline`: a successful Track All
  (not a range) closes the Timeline if it is open.
- `../ui/panel-visibility.js` — `collapseViewport3D`: the same, for the 3D viewer
  (passed `viewport3d` from `../ui/app-state.js`, which is also imported).
  No cycle: that module imports app-state, save-load, loading-overlay, settings,
  `pose/id-switch-check.js` and `ui/image-embedder.js`, none of which import the
  tracker.
- `../ui/color-by.js` — `setColorByIdentity`: a successful Track All / Track
  Frame Range that assigned identities switches Color from Tracks to ID
  (#242) and says so in the status line. Track Frame (one frame) does not.

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
to the browser on a CLOCK (`createProgressPacer` from `ui/loading-overlay.js`,
~every 250 ms, each yield waiting for one paint) and awaits `onProgress(done,
total)` just before each yield and once at the end, so **Track All** shows a
live "Assigning identities: done/total frames (pct%)…" line plus a determinate
bar (`showLoadingProgress`). It used to step every 5% of frames, which on the
36k-frame HardFight set froze the overlay ~1.7 s at a time. A non-windowed lazy
session runs a labelled "Loading frames" stage first (Step 1 of 2) through
`loadAllLazyFrames`' `(msg, done, total)` callback; the windowed path
(`sweepTrackAllFrames`) hands `onProgress` to `sweepLazyFrameWindows`, which owns
the pacing. `buildTrackerDetections` wraps each linked/unlinked instance as a `Detection`;
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
`corr2dWeight`/`corr3dWeight`/`velocityThreshold`/`distanceThreshold`/`timePenalty`/`stale`/`matchGate`
tracking thresholds (`ui/settings.js`; defaults are the `G_keeptrack_3d6`
champion values, except `distanceThreshold`/`stale` which carry the 2026-08-14
stale-anchor-fix values — see `pose/cross-view-tracker.js`). Track Frame/Track All pass the user's animal count as
`maxTargets` so the tracker caps live targets at that number (a LUCID divergence
from the reference — see `pose/cross-view-tracker.js`; `null`/omitted =
uncapped/faithful). Covered by `tests/test-crossview-populate.mjs` (data-structure
population), `tests/test-cross-view-tracker.mjs` (algorithm), and
`tests/test-tracker-collision-guard.mjs` (`commitTrackedFrame`'s raw-trackIdx
collision guard).

**Track Frame Range (#212).** `trackFrameRange(startFrame, endFrame)` tracks a
contiguous span — the middle ground between Track Frame (one frame) and Track
All (the whole video), so a user can re-run tracking over a narrow window around
a known ID switch while changing Tracking Wizard settings (node weights, camera
views, the 3D correspondence weight) instead of paying for a full pass over a
long recording. Reached from the Track Frame split button's hover dropdown via
`ui/track-range-modal.js`; **the toolbar button itself still tracks the current
frame**, unchanged.

`trackAll` and `trackFrameRange` are both one-liners over a shared
`runTrackingPass(range)` (`range === null` ⇒ Track All). Everything the two do
differently is driven by that argument, and all three differences matter:

- **Which frames are swept.** Windowed lazy sessions pass `start`/`end` through
  `sweepTrackAllFrames` into `sweepLazyFrameWindows` (whose `opts.start`/
  `opts.end` had no caller before this); non-lazy sessions filter
  `frameIndices`. The frame COUNT reported in the status line and the progress
  overlay is the range's, not the project's.
- **What prior state is cleared.** Track All wipes `identities` /
  `frameIdentityMap` / `instanceGroups` wholesale. A range must not: it clears
  only entries whose frame lies inside `[lo, hi]` (`clearTrackingStateInRange`,
  which decodes `frameIdentityMap` keys through `Session.frameIdentityEntries()`
  rather than re-deriving the packed key layout). Getting this wrong is the
  invisible-damage failure class this codebase keeps hitting — the range the
  user is looking at would still look right while everything else was destroyed.
- **Whether identities are recycled.** A range run starts the tracker from
  scratch at `lo` and carries NO history in from before it, so its targets are
  fresh objects every run. Without recycling, each re-run would mint a new
  `id_N` per animal and the identity list would grow without bound — fatal for
  the iterate-on-settings workflow the feature exists for. `runTrackingPass`
  therefore hands `commitTrackedFrame` an `identityPool` of the session's
  existing identity ids, consumed in order before `addIdentity` mints anything.
  Track All passes no pool (it cleared the list first, so `addIdentity` is
  already the reuse path there).

Every frame number in these status strings is **1-based** (`displayFrame()`),
matching the `#currentFrame` readout and the rest of the app; the stored
indices stay 0-based, and the `console.log` deliberately keeps printing raw
indices (marked `0-based`) since that line is for reading against the data
structures. Range endpoints are clamped to the session's real extent
(`trackableFrameBounds`, which prefers `lazyLoader.nFrames` over the resident-only
`frameIndices` — the same trap the fresh-open guard fell into) and normalized if
reversed; a non-integer endpoint is refused outright, because every comparison
against `NaN` is false and it would otherwise sail past the ordering check and
sweep nothing while reporting a `NaN` range. Like Track All, a range run does NOT propagate to tracks.
`getTrackerNumAnimals` / `setTrackerNumAnimals` expose the animal count so the
modal can collect it inline; `runTrackingPass` skips the native `promptNumAnimals()`
on the range path so a `prompt()` never stacks on top of the dialog.
`runTrackingPass` **returns** `{ok, start, end, identities, frames}` — `ok:false`
for every bail-out, and on success the CLAMPED, normalized span actually swept.
Callers cannot recompute that span (the request is clamped to the project extent
and reversed input is normalized), and the modal uses `end` to park the viewer
on the last frame tracked. Covered by
`tests/e2e/track-frame-range.mjs` (range scoping, identity recycling, clamping,
the windowed sweep, and the toolbar → modal → loading-overlay path; its three
core assertions were each confirmed to fail under a deliberate mutation).

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
in the talmolab/sleap-3d repo (Python) and reimplemented in JS; originally a
faithful port of `/root/vast/eric/sleap-3d/sleap_3d/tracker.py`, and as of
2026-08-14 no longer byte-faithful — see "Stale-anchor fix" below. A cross-view
3D multi-target tracker: associates per-camera 2D detections to a running list
of 3D `Target`s, one camera-view at a time, via Hungarian assignment on a cost
that sums a 2D reprojection term and a 3D point-to-ray term. Still no Kalman
filter, no velocity model (matches the reference).

**"All geometry is coordinate-agnostic" — true of everything it imports EXCEPT
the triangulation.** The file header makes that claim, and it holds for
`reprojectPoint`, `backProjectToRays`, `pointsToRayDistances` and
`epipolarErrorMatrix` (the fundamental matrix is the relative pose, invariant to
1e-19 under a re-base). It did NOT hold for `triangulatePoints`, which
`_retriangulate` calls to build `target.points3d` — the single frame-dependent
input to both cost terms, which are otherwise geometric given that 3D. A ~1.2 m
re-base moved it by up to 15 mm, and since `_adjacency3d` divides millimetre
distances by `distanceThreshold` (default **1.0**), that is a cost swing of ~15
per node. 21% of frames came out grouped differently. Fixed in
`triangulatePointDLT` (see `pose/triangulation.js`), not here — the tracker was
right to assume invariance; the estimator was not delivering it. Note the
tracker calls `triangulatePoints` (DLT) unconditionally and never
`triangulatePointsBA`, so the Settings "Refined" method does **not** reach this
path.

**Stale-anchor fix (2026-08-14).** The reference keeps one detection per camera
FOREVER (never expired) and re-fuses mid-frame, mutating the shared target list
one camera's Hungarian at a time — so after an occlusion a target's 3D anchor
stays frozen at wherever it was last seen, and the surviving animal's own
detection can drift closer to that stale ghost than to its own target,
permanently swapping the two identities with nothing downstream able to detect
it. Validated on real multi-view rodent corpora in `talmolab/luc3d@eric/figs`
(`figs/fig8-bench/xv_experimental.js`, methods M1 `sync`/`stale`): BMimica
cross-view switches 2,071 → 413 (50 sessions), SLAP-2M within-view switches
3,094 → 1,312 / IDF1 0.7040 → 0.7212 (42 multi-animal sessions), at the
recommended `stale: 20` + `distanceThreshold: 25` (`corr3dWeight` unchanged at
6). Two changes, both additive (default/zero config reproduces the pre-fix
tracker exactly):
- **`stale` (hp, frames, default 20).** At the start of every `trackFrame()`
  call (`_beginFrame`), evict any `detsByCam` entry older than `stale` frames,
  before that frame's association runs, so `_retriangulate` can no longer fuse
  one fresh view with several ancient ones. `0` restores the pre-fix,
  unbounded-staleness behavior. Wired from the Tracking Wizard's new `stale`
  threshold (`ui/settings.js`) via `crossViewHyperparams()` (`pose/tracker.js`).
- **Frame-synchronous association (unconditional, no flag).** A target's
  `points3d`/`frameIdxMean()` snapshot (`_snapMean`) is frozen at frame start
  and every camera's Hungarian this frame is scored against it; the one
  `_retriangulate()` happens once, in `_endFrame()`, after every camera in the
  frame has been processed — replacing the reference's mid-frame
  Gauss-Seidel-style mutation with a Jacobi-style update. `_adjacency2d`/
  `_adjacency3d` still read `target.points3d` directly (unchanged signature) —
  it is simply not mutated again until frame end — so calling them directly
  outside a `trackFrame()` lifecycle (as `tests/test-crossview-features.mjs`
  does) is unaffected; `_snapMean` is `null` there and the live
  `frameIdxMean()` is used instead, matching pre-fix behavior exactly. Births
  (`_initializeTargets`) still retriangulate immediately, unchanged, since a
  target born mid-frame has nothing for `_endFrame` to defer.
`distanceThreshold`'s Tracking Wizard default moved 50 → 25 alongside this
fix (`ui/settings.js`); `scripts/bench/hooks.mjs`'s `THRESHOLD_DEFAULTS` was
updated to match (its own comment requires staying in sync).

**Match gate (2026-10-03, `matchGate` hp; default OFF since 2026-10-07, #285; 1 = on).**
Off by default because on Eric's proofread benchmarks it helped SLAP-2M but gave
about 6x the ID switches on Mouse-Dyad-10M and about 10x on s-DANNCE (#285); 0 is
the pre-gate tracker exactly, so the default is the tracker from before #248. The reference
Hungarian is forced: whenever a view has at least as many detections as
targets, every target takes one, however negative its adjacency. One spare
target (left by an earlier false birth — common when the animal count is
auto-detected from views that also see reflections) plus one extra detection (a
reflection) is then enough to trade a correct match away. On the real
`194366_05mice_flippers` recording (5 mice, 8 cameras) at frame 3,620,
Camera4_topR, the spare scored -26.7 on the real mouse while that mouse's own
target scored +55.9, both scored about -600 on the reflection, and the summed
optimum gave the mouse to the spare and the reflection to its target — a
persistent switch. `_trackView` now runs two `_assign` stages: **tracked**
targets (still holding a detection after stale eviction) get one "no match"
column each at adjacency 0, so they only take a detection they score
positively on; then **lost** targets (`_lost`, set in `_beginFrame` when
eviction emptied `detsByCam`) take the leftovers, forced, as before — the
re-acquisition path for an animal unseen for `stale` frames. Measured on the
whole recording (108,000 frames, tail nodes weight 0): with 5 animals,
one-frame 3D jumps > 50 mm (a group bundled with a wrong detection) 195 → 1,
group members reprojecting > 30 px 1.64% → 0.66%, frames with all 5 groups
committed 99.88% → 99.63%; with 7 (auto-detect), jumps 341 → 29 and id_0–id_4
stay committed far more of the time. `matchGate: 0` reproduces the pre-gate
tracker exactly (same events on all 108,000 frames). Wired from the Tracking
Wizard's `matchGate` threshold (`ui/settings.js`) via `crossViewHyperparams()`
(`pose/tracker.js`); `scripts/bench/hooks.mjs` mirrors the default. Covered by
`tests/test-cross-view-tracker.mjs` (the swap in miniature — fails with the
gate off — and lost-target re-acquisition, which fails under a naive gate that
also gates lost targets).

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

**Faithful-port quirks still preserved (do NOT "fix" without new measurement —
not implicated by the fig8-bench search).** `velocity`/`distance` thresholds are
SOFT (drive the cost negative, not hard gates) and negative matches are not
filtered; the 3D term ignores the time gap; 3D velocity is zero;
re-triangulation is plain DLT over all (now freshness-filtered) stored per-view
detections. Adds a defensive `nansum`-style skip of non-finite cost terms
(robust to a degenerate `[I|0]` camera).

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

**The pure math now lives in `pose/triangulation-core.js`** (DLT,
refinement, reprojection, errors, `triangulateAndReproject`, `invert3x3`) so the
Triangulate All worker pool can load it; this module imports it and
**re-exports every public name**, so all existing imports keep working. It
installs the core's two settings hooks (`setTriangulationSettingsHooks`) with
`isCameraTracked` / `getTrackingThreshold`.

**Performance (profiled on HardFight_1kModels, outputs bit-identical — see
`tests/test-triangulation-kernels.mjs` and the `_bench-progress-overlay.mjs
DIGEST_OPS=1` digests).** `cameraCenter` and `backProjectToRay(s)` derive a P's
null vector and pseudo-inverse from P alone; Track All asked for them per
detection per frame (~6.8 s of 17 s). They are now memoized per P array
(`_pGeometry` / `_pseudoInverse`, a WeakMap) and VALIDATED on every hit against
a snapshot of P's 12 entries, so an in-place-mutated P recomputes; returned
centres are copies. Triangulate All's per-group step is split into
`_prepareGroupStep` (camera fix-ups, >=2-usable-views gate, `usedCameras`) /
solve / `_applyGroupStep`, so `triangulateAllFrames` (eager and the windowed
`sweepTriangulateAllFrames`) submit solves to `pose/triangulation-pool.js` and
apply results in submission order; `_triangulateGroupStep` (prepare + inline
solve + apply) remains for Triangulate Range. Measured: Track All 16.9 s ->
7.4 s, Refined Triangulate All 78.5 s -> 8.8 s, DLT 8.5 s -> 2.3 s.

**`triangulatePointDLT` is frame-invariant, and that is load-bearing** — see
`pose/triangulation-core.js`, which is where it now lives.

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
restrict it to a range. The playback eviction is HELD for the whole sweep
(`holdLazyResidency`, released in a `finally` by the exported wrapper around
`_sweepLazyFrameWindowsHeld`): it protects windows around the on-screen frame,
not the window being swept, so a draw landing in one of the sweep's yields could
otherwise drop frames the sweep hydrated but has not visited yet. **The window
release also gives each released frame's group members' 2D back to the store**
(`releaseFrameMembers2d`, `pose/lazy-residency.js`): each window's hydration
re-adopts every member's row, and Track All builds its groups from the
instances it hydrated, so without this one sweep left every member of the
project holding a private copy of its 2D (4,152,565 members / 1.39 GB on the
real 8-camera project). Solver jobs capture their 2D at submit, so releasing a
window whose solves are still in flight is safe. **Progress/yielding is clock-paced**
(`createProgressPacer`, `ui/loading-overlay.js`): `opts.onProgress(done, total)`
is awaited just before each ~250 ms yield and once at the end, where `done` is the
sweep POSITION (frames passed, data or not), so it rises monotonically to `total`
and can drive the overlay bar directly; `opts.onLoadProgress(done, total)` reports
the non-windowed branch's up-front `loadAllLazyFrames` stage (`opts.onStatus(msg)`
is the text-only fallback). It used to yield every 100 processed frames (`opts.
yieldEvery`, removed) and report a processed count that jumped at window ends.
It replaced three byte-identical copies
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

Naming note: the user-facing label is **"Refined" / "Ref"** (Settings ▸ Default
Triangulation shows "Refined (Ref)"; the Triangulate / Triangulate All dropdowns
show "Ref"). It was formerly "Bundle Adjustment" / "BA", after anipose/SLEAP's
term for `optim_points`, but that name wrongly implied camera refinement. Only
the display strings changed: the method key is still `'ba'` in `options.method`,
`group.triangulationMethod`, `localStorage`, and the per-group
`metadata.lucid.triangulationMethod` written to the `.slp`.

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
provenance ("N kept existing 3D, N solved via Refined, N via DLT") in
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
  `triangulationMethodLabel(method)` → `'DLT'` | `'Refined'`.
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
- Plane fitting (View ▸ Define Planes):
  `fitPlaneToPoints3d(points3d)` → `{centroid, normal, rms, nPoints}|null` —
  **now defined in `pose/plane-fit.js` and merely RE-EXPORTED here**, so
  `pose/plane-data.js` can reach it without importing this UI-coupled module;
  every existing caller and test still reads it from here. `jacobiEigen` moved
  with it and is imported back for the DLT solver. Also
  `projectPoints3dOntoPlane(points3d, plane)` → a NEW flat `points3d` with every
  present point dropped onto the plane (input untouched, missing nodes stay
  missing), which stays here. The fit is **total least squares via PCA** — the
  normal is the eigenvector of the smallest eigenvalue of the points' 3x3
  covariance, via `jacobiEigen` (which returns eigenvectors as ROWS paired
  with unsorted `eigenvalues[i]`). Perpendicular distance is the right objective
  because the corners carry error in all three axes; an ordinary least-squares
  fit of z on (x, y) would privilege an axis and blow up edge-on. Returns
  **null** for fewer than 3 points, coincident points, or COLLINEAR points —
  collinear input admits infinitely many planes, so a normal there would be
  arbitrary and "fitting" to it would silently rotate the annotation to
  nonsense. Detected via the middle eigenvalue relative to the largest.
- CONSTRAINED plane fitting (IMMUTABLE / "frozen" plane nodes):
  `fitPlaneConstrained(points3d, options)`,
  `projectPoints3dOntoPlaneConstrained(points3d, plane, immutable)`,
  `mergeFrozenPoints3d(solved, frozen, immutable)`,
  `summarizePlaneTriangulation(points3d, nodeErrors, immutable)`,
  `planesInvalidatedByFit(movedNodeIds, planes, excludePlaneId)`,
  `orientNormalLike(normal, previous)`, `normalizeImmutableMask(immutable, n)`,
  and the constants `PLANE_COPLANAR_TOL_FRAC` (1e-3), `PLANE_COPLANAR_TOL_FLOOR`,
  `PLANE_ANCHOR_COND_FRAC` (κ = 1e-3), `PLANE_MUTABLE_DEVIATION_FRAC` (0.05).
  All PURE and model-agnostic: they take a flat `points3d` plus a plain
  immutability spec (`Set` of indices | boolean mask | index list, normalized by
  `normalizeImmutableMask`), never the plane node-pool objects. An immutable
  node's 3D is FROZEN — not moved by 2D editing, by triangulation, or by the
  fit — so the fit minimizes the SAME perpendicular residual subject to hard
  linear constraints: pin the offset with an anchor, restrict the normal to an
  admissible subspace `N` (3×q), take the smallest eigenvector of `NᵀMN` where
  `M = Σ(p−a)(p−a)ᵀ` over the MUTABLE points, **scattered about the anchor, not
  the centroid** (`M = S_c + m(c−a)(c−a)ᵀ` — genuinely a different matrix from
  the free fit's). q follows the frozen set's rank: rank 0 (1 anchor, or several
  coincident) ⇒ q=3; rank 1 (2 anchors, or 3+ collinear) ⇒ q=2, solved in closed
  form as a 2×2 eigenproblem in the basis of `d⊥`; rank 2 (3+ non-collinear) ⇒
  q=1, the anchors alone determine the plane and the mutable points get **zero**
  weight (hard constraints, not weighted). Exactly 3 non-collinear anchors use
  the **exact cross product**, no eigen solve. 4+ are OVER-determined and are
  free-fit alone first (reusing `fitPlaneToPoints3d`) and rejected unless
  `rms ≤ max(τ·anchorDiameter, floor)`.
  **The 0-immutable case deliberately does NOT come through here** — it returns
  `code: 'not_constrained'` and the caller must use `fitPlaneToPoints3d`, whose
  floats are pinned by `tests/e2e/define-plane-mode.mjs`.
  **Every threshold is SCALE-RELATIVE** (a fraction of the point set's
  diameter): scene units are whatever the calibration used, so an absolute
  millimetre tolerance would misfire on either a bench rig or an arena.
  **Result object** — `{ok, code, message, plane, anchorIndices, anchorNames,
  mutableIndices, mutableNames, warnings[], metrics}`. `code` is
  machine-readable so the UI decides block-vs-confirm **structurally, never by
  sniffing the message**: `ok` | `not_constrained` | `no_anchor_3d` |
  `anchors_collinear` | `anchors_noncoplanar` | `underdetermined`. `warnings[]`
  carries the non-fatal half — `anchors_collinear_relaxed` (a 3rd+ collinear
  anchor adds no information, so it relaxes to the 2-anchor line case),
  `anchors_coincident`, and `mutable_far_from_plane` (the flatten is well
  defined but drastic — the UI should confirm, not block). Every message is
  keyed to node NAMES with the plane name for disambiguation, never indices,
  because the global node pool makes duplicate names likelier.
  **Fails before mutating**: validation returns without reading or writing
  anything further, and the flatten is a separate call.
  **`hasPoint3d` only rejects NaN**, so an ±Infinity anchor would sail through
  it into `jacobiEigen` (which has no NaN/Inf guard) and yield a garbage
  eigenvector — anchors are therefore checked with an explicit `isFinite` and
  return `no_anchor_3d`.
  `projectPoints3dOntoPlaneConstrained` copies immutable coordinates through
  **bit-identically** (a raw element copy, NOT "projecting an on-plane point is a
  no-op" — round-off makes that false, and a frozen point drifting an ulp per
  re-fit is the exact silent corruption the flag exists to prevent).
  `summarizePlaneTriangulation` reports `nNodes`/`meanError` over MUTABLE nodes
  only and the frozen residuals separately as `nAnchors`/`anchorMeanError` plus a
  per-node `provenance` (`'frozen'`|`'triangulated'`|`'missing'`): a frozen
  node's residual is an OUT-OF-SAMPLE residual — no DOF were spent fitting it —
  so folding it into `meanError` misrepresents the solve the user is judging.
  `planesInvalidatedByFit` does not block a shared-node fit (co-owning a node is
  ordinary work); it tells the UI whose `planeFit` to drop after a fit moved a
  node they share. **The user's instrument for pinning a shared intersection
  line is the immutable flag** — freeze the shared nodes and neither fit moves
  them. Covered by `tests/test-plane-constrained-fit.mjs`, which checks the 1-
  and 2-anchor solves against a brute-force search over the admissible normals
  (a fit that centred on the centroid would still produce a plausible-looking
  plane through the anchor; only a residual comparison catches it).
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
  for worker-free loaders), `loadAllLazyFrames`, `ensureLazyTrailWindow(frameIdx,
  trailLength)`, and `evictLazyFrames(anchorFrame)`
  — the app-state wrapper around `pose/lazy-residency.js`'s
  `evictLazyFrameGroups`. A no-op until `session.frameGroups` exceeds
  `LAZY_RESIDENT_CAP`; then it protects windows around the on-screen frame and
  `anchorFrame`, keeps at least the node-trail length behind them, passes every
  object the InteractionManager holds (`_uiHeldObjects`: selection, Group-mode
  picks, an unlinked drag, the Edit Group target) and `state.triangulationResults`.
  Called after a NEW frame is hydrated by `ensureLazyFrameData`,
  `ensureLazyTrailWindow` and the playback
  loader (`ui/ui-wiring.js`), never from `batchLoadLazyFrames`. It had existed
  since before the module split with no caller at all, which is why playback
  kept every frame it ever hydrated (see `pose/lazy-residency.js`). The loader's
  own caches are bounded separately (its 100-frame adapted-dict LRU and
  sleap-io.js's `frameCacheLimit`).
  `ensureLazyTrailWindow(frameIdx, trailLength)` hydrates the `trailLength`
  frames BEHIND `frameIdx` — the node-trail window, which a seek's own
  hydration (target + 30 ahead) does not reach. Called by `drawAllOverlays` and
  by the overlay-video export (preview and each exported frame, with the
  export's own trail length). Synchronous for `SioLazyLoader` (built before it
  returns, then one `evictLazyFrames`); for the worker loader it returns a
  Promise of the frames loaded and keeps at most one request in flight.
  Measured on a synthetic 8-camera, 5-animal, 15-node project
  (`tests/e2e/_bench-trail-window.mjs`): when the window is already resident,
  which is every playback frame, it costs ~1.7 µs at a 500-frame trail, and
  2,500 simulated playback steps (with the playback loader's load + eviction)
  built 0 frames; filling it after a jump costs ~1 / 11 / 50–60 ms at
  10 / 100 / 500 frames. On the real 8-camera, 108,000-frame project
  (`_bench-playback.mjs`, A/B against the parent commit) playback draws/s and
  overlay cost were within run-to-run noise at both 10 and 500 frames, jump
  times were unchanged, and the window fill (~80 ms per jump at 500 frames)
  showed up in the first step after each jump.
  `LazyFrameLoader` spawns `loading/slp-import-worker.js` (resolved against
  `document.baseURI` so sub-path deployments work — see ISSUES.md I-8) for HDF5
  reads.
  **`LazyFrameLoader`'s tracks are the union over its cameras, whichever worker
  answers first.** Each worker's `metadata` message goes through
  `_registerCamera`, which picks the skeleton of the first camera BY NAME and
  calls `_unifyTracks`: `trackNames` = the union of every camera's own names
  (`loading/track-union.js`; `_ownTrackNames` pads a list shorter than the
  data's `nTracks` with the worker's own `track_<i>` convention), plus a
  per-camera own→session map kept only where it is not the identity. It used to
  take `trackNames` from the first `metadata` to arrive — the same first-wins
  bug as `SioLazyLoader`. A worker only knows its own file, so frames are
  re-indexed as they ARRIVE, in `onmessage` (`_remapFrameTracks` on
  `frameData` and `framesData`) — the one place `getFrame`, `prefetch` and
  `batchLoadLazyFrames` (which posts to the workers directly) all pass through.
  A camera whose map moved has its dense occupancy grid re-keyed into the SPARSE
  form by `denseOccupancyToSparse` (a wider dense grid would cost nFrames × the
  whole union); an identity camera keeps its grid as is. Covered by
  `tests/test-lazy-track-union.js`.
  **A hydrated trackless instance is `trackIdx: null`, never `-1`.** Both lazy
  loaders hand over the columnar store's trackless value, `-1`, and the four
  hydration paths — `ensureLazyFrameData`, `hydrateLazyCameras`,
  `buildLazyFrameGroupSync`, `batchLoadLazyFrames` (both branches) — passed it
  straight into `new Instance`, while every eager path normalizes to `null`
  (`resolveImportTrackIdx`) and the readers test `trackIdx == null`. So a lazily
  hydrated trackless instance drew in the palette's LAST track colour
  (`getTrackColor(-1)` wraps) instead of `UNGROUPED_USER_COLOR`, got a
  "Track -1" pill from `getInstanceLabelName`, and lost the identity an
  ungrouped trackless instance retains (luc3d #201). All four now go through
  `lazyInstanceTrackIdx` (`>= 0` kept, anything else `null`). The STORE keeps
  `-1` — `appendStore`, `forEachInstanceRow` and `remapTracksFromIdentity`
  speak it — so the mapping happens exactly where a store row becomes an
  `Instance`. `frameIdentityMap` keys `null` and `-1` alike (`Session._fimKey`),
  so no saved identity moves. Covered by `tests/e2e/lazy-trackless-null.mjs`
  (every path, the colour, the label and the retained identity; confirmed to
  fail pre-fix).
  **A FrameGroup that exists is not necessarily complete.**
  `ensureLazyFrameData` used to open with a bare
  `if (session.frameGroups.has(frameIdx)) return;`, which is only sound when
  every camera is lazy-backed. `handleLoadSessionFolderPerCamera` could route a
  folder part eager and part lazy, and the eager cameras create the FrameGroup
  at load time — so that guard skipped the frame and the lazy cameras were never
  hydrated at all, on any frame. It now asks which lazy cameras the existing
  group carries no data for (`lazyCamerasMissingFrom` — checks BOTH
  `fg.instances` and the unlinked pool, since the per-camera folder loader moves
  everything it parses into the latter) and hydrates only those
  (`hydrateLazyCameras`), returning immediately in the normal case where nothing
  is missing. The new rows are staged in a throwaway FrameGroup so
  `finalizeLazyFrameGroup` runs on exactly the new cameras and cannot re-unlink
  instances an eager parse already placed; whatever it produces is merged in.
  A camera hydrated concurrently is re-checked after the `await`, so a scrub
  racing this cannot double-add. `lazyCamerasMissingFrom` is **exported** and
  unit-tested in `tests/test-lazy-camera-hydration.js` — it is the predicate
  that decides whether a view comes back with its labels, and it can fail in
  two opposite directions (call a loaded camera missing and the frame renders
  every instance twice; call a missing one present and the view stays blank),
  so it is worth pinning in the fast browser suite as well as end to end. The folder loader also no longer produces a
  mixed session at all (see `loading/session-loader.js`) — this is the
  independent half, and `tests/e2e/percam-mixed-lazy-eager.mjs` reaches it
  directly by emptying one camera out of a hydrated FrameGroup, asserting the
  repair, that the other cameras are untouched, and that a second pass adds
  nothing (the #194/#195 re-materialize-duplicate class).
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
  **`batchLoadLazyFrames`'s worker branch never called `finalizeLazyFrameGroup`
  (luc3d #209).** The `isSync` branch (`SioLazyLoader`, in-memory `.slp`
  projects) has always called `buildLazyFrameGroupSync` per frame, which calls
  `finalizeLazyFrameGroup`. The OTHER branch — worker-backed `LazyFrameLoader`,
  used for SLEAP analysis `.h5` prediction files
  (`loading/session-loader.js`: `!lazyAreSlp ? new LazyFrameLoader()`) — built
  its `FrameGroup` and then unconditionally dumped every raw instance into the
  unlinked pool, regardless of whether `session.instanceGroups` already had
  real (possibly hand-labeled `'user'`) groups for that frame. Symptom: a
  frame rebuilt via this path looked completely untracked/unlabeled the first
  time it was (re)visited after being evicted — reported as Bundle-Adjustment
  reprojections "becoming predictions" starting around frame ~5,500, which
  lines up with `loadAllLazyFrames`'s `BATCH = 5000` sweep window and
  `ui/ui-wiring.js`'s then-5000-frame playback preload (`batchLoadLazyFrames(cur,
  5000)`, now `LAZY_PLAYBACK_AHEAD`) — any frame outside what's already resident
  takes this branch on first touch. Fixed by calling `finalizeLazyFrameGroup(session, fg,
  frameIdx)` here too, exactly mirroring the `isSync` branch. Regression test:
  `tests/e2e/batch-lazy-hydration-worker-loader.mjs` (fakes the worker with a
  synchronous `postMessage` stand-in; confirmed failing pre-fix — both the
  pre-existing group's member AND the unrelated raw row landed in the
  unlinked pool — and passing post-fix).
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
  found no groups and bailed. Its **unlinked** rows are bucketed with
  `session.getIdentityIdForUnlinkedInstance`, not the track-keyed resolver: a
  trackless ungrouped instance carries its identity on the instance, not in the
  trackIdx-keyed map (luc3d #201), so asking by track silently dropped exactly
  the instances an ungroup had produced and a regroup-by-identity could not put
  back what the ungroup took apart. Same fix in
  `groupByIdentityAndTriangulateAll` (`ui/export-modals.js`), which duplicates
  this bucketing; tracked rows are unaffected either way.

**Imports from project modules.**
- `./pose-data.js` — `mat3x3Multiply`, `FrameGroup`, `Instance`,
  `UnlinkedInstance`, `InstanceGroup`, `pooledPoints3d` (`_applyGroupStep`
  stores every Triangulate All result in the slab pool).
- `../ui/app-state.js` — `state`, `timeline`, `viewport3d`, `interactionManager`
  (the objects `evictLazyFrames` must not drop out from under the UI).
- `./lazy-residency.js` — `evictLazyFrameGroups`, `holdLazyResidency`,
  `releaseLazyResidency`, `LAZY_RESIDENT_CAP`, `LAZY_KEEP_BEHIND`.
- `../ui/rendering.js` — `setReprojErrorVisible`, `showReprojectionsOnly`,
  `REPROJ_ONLY_NOTE` (Triangulate All ends Reproj-only — #243), `drawAllOverlays`.
- `../ui/info-panel.js` — `updateTriangulationBadge`.
- `../ui/settings.js` — `isCameraTracked`, `getTrackingThreshold`,
  `getDefaultTriangulationMethod` (the fallback in `resolveTriangulationMethod`).
- `../import-export/save-load.js` — `markDirty`, `setStatus`,
  `showLoading`, `hideLoading`.
- `../ui/loading-overlay.js` — `showLoadingProgress`, `createProgressPacer`,
  `yieldToPaint` (Triangulate All's eager loop and `sweepLazyFrameWindows`).
- `./triangulation-core.js` — the pure math (re-exported) and
  `setTriangulationSettingsHooks`.
- `./triangulation-pool.js` — `createGroupSolver` (Triangulate All's parallel solve).
- `../loading/track-union.js` — `unionTrackNames`, `remapTrackIdx`,
  `isIdentityRemap` (`LazyFrameLoader`'s track union).
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

### pose/lazy-residency.js

**Purpose.** Keep a LAZY project's resident frames bounded during playback,
without ever dropping a frame that holds anything the store cannot rebuild. On a
lazy project `session.frameGroups` is meant to be a window, but nothing evicted
it: `evictLazyFrames` had no caller, and the playback loader kept 5,000 frames
hydrated ahead of the playhead, so every played frame stayed. Measured on the
8-camera `05mice_flippers` project (108,000 frames, per-camera `.slp` > 150 MB):
resident frame groups 5,145 -> 31,600 over five 20 s runs, heap toward the
renderer's ~4.2 GB limit. After a Triangulate All the draw path also caches
reprojections for every drawn frame (`fillLazyReprojections`), forever.

**Key exports.** `evictLazyFrameGroups(session, { anchors, ahead, behind, cap,
refs, triangulationResults })` -> `{ resident, evicted, protected, blocked,
membersReleased }` or null (no lazy loader, at/under `cap`, or held);
`frameEvictionBlocker(session, frameIdx, fg, refs)` -> a reason string or null;
`releaseFrameMembers2d(session, frameIdx, { refs })` -> members released;
`hydrateFrameMembers2d(session, frameIdx)` -> members hydrated;
`member2dReleaseBlocker(member, desc, numNodes, refs)` -> a reason or null;
`holdLazyResidency` /
`releaseLazyResidency` / `isLazyResidencyHeld` (nestable); `lastLazyEvictionPass()`
(diagnostics); `LAZY_PLAYBACK_AHEAD` (600, the playback loader's lookahead),
`LAZY_KEEP_BEHIND` (512, > the 500-frame maximum node trail),
`LAZY_RESIDENT_CAP` (1536), `LAZY_PREFETCH_MARGIN` (32, covers
`ensureLazyFrameData`'s 30-frame scrub prefetch).

**Contract — a frame is dropped only if ALL hold:**
- It is outside every protected window `[anchor - behind, anchor + ahead]`
  (default `ahead` = `LAZY_PLAYBACK_AHEAD + LAZY_PREFETCH_MARGIN`).
- No hold is active (the windowed sweeps hold for their whole run).
- **Re-hydration would rebuild exactly what is resident** (`frameEvictionBlocker`
  returns null). Re-hydration makes one Instance per store row tagged
  `_rawInstIndex`, re-seats this frame's `instanceGroups` members by
  `_rawInstIndex` (`finalizeLazyFrameGroup`) and unlinks the rest. So: every
  camera with data must be backed by the loader (`'camera'`); per camera the
  resident instances must be a bijection onto the store rows (`'count'`, `'row'`);
  linked instances must be exactly the members re-seated there and unlinked ones
  must not be (`'grouping'`); no instance may be `'user'` (the streaming save
  reads its edit overlay from RESIDENT frames — `buildSessionRefGraph`), modified,
  backed-up mid-edit or nulled (`'modified'`), resized by a skeleton edit
  (`'skeleton'`), or held by the UI (`'ui'`); and each unlinked instance must
  still match its row — track (`'track'`), type (`'type'`), and no #201 identity
  stamped on the instance (`'identity'`, not persisted). Group members' own fields
  are not compared: they survive in `instanceGroups` (never evicted) and come back
  as the SAME objects. Points are not compared — every 2D edit path promotes to
  `user`, sets `modified` or `nulledNodes`. A loader without
  `describeStoreFrame` (the worker-backed `LazyFrameLoader`) never evicts.
- Dropping a frame also drops its DERIVED reprojection caches
  (`group.reprojections`, `group.reprojectedInstances`, its
  `triangulationResults` entry) — the state `sweepTriangulateAllFrames` leaves
  every frame in; `fillLazyReprojections` re-derives them on the next draw.

**Group members' 2D goes back to the store too.** `instanceGroups` is never
evicted, but a member of a frame that is NOT resident need not hold its 2D.
Measured after Track All + Triangulate All on the 8-camera 108,000-frame
project: 4,152,565 members, every one an untouched prediction holding a private
`Float64Array` copy of its store row — 1.39 GB (443 MB V8 heap + 951 MB backing
stores) and ~4.2M ArrayBuffers that every full GC sweeps; with them released,
`usedJSHeapSize` went 5,057 -> 3,745 MB and the five-run tracked playback bench
stopped degrading (57.5 ... 51.6 -> 58.7 ... 58.8 new images/s, 0 long
animation frames). `releaseFrameMembers2d` points each releasable member at the
shared `lazyPlaceholderXY` and sets `_lazy2d` — exactly a reopened project's
lightweight member — and `finalizeLazyFrameGroup` re-adopts the row's 2D the
next time the frame is hydrated. Rules:
- **Only for a NON-resident frame** (its members are what is on screen), never
  for a group or member the UI holds, and only for a member re-hydration would
  give back exactly (`member2dReleaseBlocker`): an untouched prediction — not
  `'user'`, `'modified'`/mid-edit/nulled, no `'occlusion'` set (hydration brings
  occlusion back clear), no `'skeleton'` change — whose store `'row'` exists and
  is a prediction. Its other fields (track, type, score, identity) stay on the
  member object; only `_xy` is given back.
- **Re-adoption keys on the member's CURRENT `_rawInstIndex`**, never a cached
  row or position — a store compaction (Custom Delete, interactive deletes)
  renumbers released members too, and must keep pointing each at its own row.
- **Where it runs:** wherever a frame stops being resident — the windowed
  sweeps' window release and `evictLazyFrameGroups`. A reader that needs member
  2D of a frame it does not hydrate brackets the read with
  `hydrateFrameMembers2d` / `releaseFrameMembers2d` (the image ID-switch check's
  `frameCropGeometry`, `ui/image-embedder.js`); `hydrateFrameMembers2d` builds
  each row exactly as `buildLazyFrameGroupSync` + `finalizeLazyFrameGroup` do
  and does NOT make the frame resident.

**Imports from project modules.** `./pose-data.js` (`Instance`,
`lazyPlaceholderXY`) — still DOM-free, so the Node test can drive it.

**Imported by.** `pose/triangulation.js` (`evictLazyFrames`,
`sweepLazyFrameWindows`), `ui/ui-wiring.js` (`LAZY_PLAYBACK_AHEAD`),
`ui/image-embedder.js` (`hydrateFrameMembers2d`, `releaseFrameMembers2d`).

**Coverage.** `tests/test-lazy-residency.mjs` (every blocker against an untouched
twin, windows, cap, holds, the reprojection drop, a simulated 20,000-frame
playback, and the constants against the code they protect; fails 28 checks with
the predicate gutted); `tests/e2e/lazy-playback-eviction.mjs` (`describeStoreFrame`
vs the real sleap-io.js materializer on every row, and evict -> re-hydrate through
the real path rebuilding every frame identically); `tests/e2e/sequence-lazy-workflow.mjs`
cycle 7 (edits, the real playback loader played far past the cap, save, reopen —
fails with the `user`/`modified` blockers removed: a member's edit is lost on save).

---

### pose/triangulation-core.js

**Purpose.** The pure triangulation math, split out of `pose/triangulation.js`
so a Web Worker can load it: matrix helpers (`matMul`, `matTranspose`,
`solveSmallestEigenvector4x4`, `svd3x4`), DLT
(`triangulatePointDLT`, `triangulatePoints`), the "Refined" point stage
(`triangulatePointBA`, `triangulatePointsBA`, `BA_ROBUST_SCALE_PX`),
reprojection (`reprojectPoint(s)`, `reprojectPointCamera(s)`, `cameraDepth` —
the homogeneous `w`, POSITIVE in front of the camera, which any caller
reprojecting into a camera it did not choose must gate on), errors
(`computeReprojectionError(s)`, `computeMeanReprojectionError`), `invert3x3`,
and the full per-group pipeline `triangulateAndReproject`.

**Key exports.** All of the above, plus `setTriangulationSettingsHooks({
isCameraTracked, getTrackingThreshold })` — the only app state the pipeline
reads (unset = every camera included, no threshold; the main thread installs
them, a worker gets resolved values via `options.includedCameras` /
`options.reprojErrorThreshold`) — and `__triangulationKernelsForTest`.

**Allocation-free hot paths, bit-identical by construction — except the DLT's
null-vector solve.**
- DLT matrix: `dltNormalMatrixFlat` builds M = AᵀA with the exact operations of
  row arrays -> `matTranspose` -> `matMul` (same A entries, same k-ordered sums
  from 0) on preallocated typed arrays. It sums only the upper triangle and
  mirrors it, which is exact: each product has the same two factors, and IEEE
  754 multiplication commutes.
- DLT solve: `dltHomogeneousFlat` finds M's null vector with
  `smallestEigvec4Inverse` — **inverse iteration**: Cholesky of `M + δI`
  (`δ = 1e-15·trace`, so an exactly singular M factors; the shift changes no
  eigenvector), then solve-and-normalize from a fixed start until no entry
  moves by more than `INVERSE_TOL` (1e-15). This is the one deliberate break
  from bit-identity. The Jacobi kernel it replaced, `smallestEigvec4Flat`
  (still bit-identical to `jacobiEigen` -> smallest-|λ| pick), cost ~1.7 µs per
  solve — atan2/cos/sin for each of ~30 rotations — and Track All runs ~9M of
  them: **15.1 s of a 65 s Track All** on the 5-mouse, 8-camera, 108,000-frame
  recording (23%, the largest single function in the profile). Inverse
  iteration is ~0.35 µs (4–5 steps on clean systems; one view ~50 px off, 5–9).
  Systems whose two smallest eigenvalues are close (a 300 px outlier, all views
  wild) can take INVERSE_MAX_ITER (50) steps and then fall back to
  `smallestEigvec4Flat`, as do a non-finite M and one that does not factor —
  which is exactly today's answer for those. It must CONVERGE rather than run a
  fixed number of steps: the start vector does not rotate with the world, so an
  unconverged answer depends on the frame, and the frame-invariance tests catch
  that (a 1e-5 tolerance fails two of them).
  Agreement, measured with `tests/e2e/_diag-trackall-ab.mjs` (Track All, then
  DLT Triangulate All, with `main` and with this solver, compared frame by
  frame) on seven real recordings — the 5-mouse one (108,000 frames, lazy) and
  the six proofread SLAP ground-truth sessions (18–19k frames each, 3 and 4
  mice): **identical identity groups on all 228,956 frames** (every group's
  identity and its exact 2D detection in every camera), and 3D within 8.6e-10 mm
  after Track All and after Triangulate All. Track All 65.5 -> 50.4 s on the
  5-mouse recording, 3.4–5.4 -> 2.4–3.9 s on the others (~30%). Triangulate All
  is unchanged (27.3 vs 27.7 s): it solves in the worker pool, where the DLT was
  not the bottleneck. The harness's negative control — the match gate switched
  on in one build only — differs on 4,389 of 18,058 frames, so a "0 differ" is
  a real result; a deliberately sloppy solver (tolerance 1e-4, 3D off by up to
  53 mm) still grouped every frame identically, so the tracker is robust to
  this kind of change by a wide margin.
- Refinement: `triangulatePointBA` projects through
  `_projectAndJacobian(Camera)Into`, which write into one scratch object with
  the same expressions as `projectAndJacobian`, `distortJacobian` and
  `Camera.distortPoint` (including their different r²·r² vs r⁴ association). It
  was ~11.6 s of GC in an 80 s Refined run.
Pinned by `tests/test-triangulation-kernels.mjs` (thousands of random systems,
`Object.is` per value for the bit-identical parts; for the inverse iteration:
agreement with Jacobi, a null vector no worse than Jacobi's by Rayleigh
quotient, rotation invariance, and the fallbacks). **Any edit to these kernels
must keep operation order,** or results drift in the last bits and tracker
decisions can flip — and a change to the solve itself needs a before/after
Track All on real recordings (`tests/e2e/_diag-trackall-ab.mjs`), since a tiny
3D difference is no proof that no association flips.

**`triangulatePointDLT` SOLVES IN A CAMERA-DERIVED FRAME, and that is
load-bearing.** DLT minimizes an ALGEBRAIC error, and `‖x‖ = 1` on a
HOMOGENEOUS 4-vector is not geometric: it weights the direction part `(X,Y,Z)`
against the scale part `W`, so moving the world origin re-weights the cost and
moves the minimizer. Solving in the raw calibration frame therefore made the
answer depend on WHERE THE ORIGIN HAPPENS TO BE — which
`Set as New Calibration`, whose whole contract is that it re-expresses the world
and changes no geometry, moves by ~1.2 m. Measured on the real 6-camera cage
session: identical 2D came out 0.26 mm apart at the median but 17 mm at p99 and
metres in the tail, and because `CrossViewTracker._retriangulate` scores
cross-view association against exactly these points, **21% of frames came out
grouped differently — three times worse by reprojection (16.5 px vs 51.8 px) —
purely from swapping the calibration file.**

The system is now built in a frame derived from the CAMERAS alone
(`dltNormalizingFrame`: centroid of the camera centres, unit = their mean
distance from it, cached per `projectionMatrices` array). Under a rigid change
of world frame the camera centres move with everything else, so the normalizing
frame moves with them, the normalized `A` differs only by an ORTHOGONAL factor
`diag(Rᵀ, 1)` on its columns, `‖x‖ = 1` is untouched, and the null vector maps
exactly. Two rules follow:
- **The frame must depend on the cameras ONLY.** Deriving it from the
  observations, or from a first-pass answer, makes it depend on the thing being
  solved for and the invariance argument collapses.
- **Degenerate projection matrices fall back to the raw frame**, which is the
  old behaviour — a worse answer beats no answer.

Measured effect of the change on the trusted (un-rebased) baseline: the median
point moves 0.048 mm and the median per-point reprojection error moves
**+0.0064 px**, while total squared reprojection error over 95k points falls
**74%** (7.96e10 → 2.05e10) and the worst outlier goes 201,637 px → 7,387 px —
the ordinary conditioning win Hartley normalization buys. Pinned by
`tests/e2e/triangulation-frame-invariant.mjs`, which was confirmed to FAIL on
the pre-fix build. **A noiseless fixture cannot pin this**: when the rays meet
exactly, `A·x = 0` has an exact null vector and every positive re-weighting
finds it, so the test injects noise deliberately.

`dltHomogeneousFlat` takes the frame as four optional trailing arguments
(`s, cx, cy, cz`); omitting them is the identity frame, which reproduces the raw
rows exactly — multiplying by 1 and adding 0 are exact in IEEE 754 — so the
bit-identity `tests/test-triangulation-kernels.mjs` pins is unaffected.

**Imports from project modules.** `./pose-data.js` (point3d helpers) and
`./plane-fit.js` for `jacobiEigen`, which is re-exported from here. That
function has ONE home: `pose/plane-data.js` needs the least-squares plane fit
built on it and must not import `pose/triangulation.js` (and the whole UI with
it), and `plane-fit.js` itself depends only on `./pose-data.js`, so a worker can
still load this module.

**Imported by.** `pose/triangulation.js` (re-exports), `pose/triangulation-pool.js`,
`pose/triangulation-worker.js`. Loaded before `pose/triangulation.js` by
`tests/run-node.js`.

---

### pose/triangulation-pool.js

**Purpose.** Run `triangulateAndReproject` for many instance groups on a pool
of Web Workers — the Triangulate All paths' parallel solve. Every group is
independent (cameras fixed), but the solve ran on one main thread (~1 of 12
cores busy).

**Key exports.** `createGroupSolver(cameras, { method, triangulateOnly,
expectedGroups })` -> `{ submit(group, groupCameras, cb), mark(cb), throttle(),
finish(), cancel(), parallel, workers }`; `MIN_GROUPS_FOR_WORKERS` (2000).

**Contract.**
- **Callbacks run in submission order** (jobs and `mark`s interleaved as
  submitted), so every side effect on app state happens in the old inline
  loop's order. `throttle()` bounds in-flight work (~2 batches per worker).
- A job's inputs — each camera's `_xy` copy and nulled nodes, plus the two
  settings resolved ONCE per run (the overlay blocks the UI) — are captured at
  `submit`, so a lazy window may be released while its solves are in flight.
- Cameras are shipped with the main thread's cached `R` / `Rt` / `P`, so the
  worker never re-derives a matrix. Results are bit-identical to inline.
- Inline fallback (synchronous at `submit`, same callbacks): no `Worker`, small
  runs (`expectedGroups` < 2000, where start-up dominates), or
  `window.LUCID_TRIANGULATION_WORKERS = 0`. Setting it to N > 0 forces an
  N-worker pool regardless of size (tests). A batch a worker fails on — or a
  worker that dies — is re-solved inline from the captured job.
- Pool size `min(hardwareConcurrency - 1, 16)`; workers persist between runs
  and are terminated after 30 s idle. One solver owns the pool at a time (a
  concurrent second run solves inline). Every call site passes `method:
  method` explicitly (`tests/test-triangulation-method-propagation.mjs`).

**Imports from project modules.** `./triangulation-core.js`
(`triangulateAndReproject`), `./pose-data.js` (`Instance`), `../ui/settings.js`
(`isCameraTracked`, `getTrackingThreshold` — `typeof`-guarded for the flat test
sandbox).

**Imported by.** `pose/triangulation.js` (`triangulateAllFrames`,
`sweepTriangulateAllFrames`), `ui/export-modals.js`
(`groupByIdentityAndTriangulateAll`).

**Coverage.** `tests/e2e/triangulate-all-worker-pool.mjs` — every Triangulate
All route (eager, windowed with windows released mid-flight, group-by-identity
DLT) run inline and on a forced 4-worker pool must hash identically, with a
reprojection threshold and an excluded camera in effect (and a control proving
those settings change the result).

---

### pose/triangulation-worker.js

**Purpose.** Module worker for `pose/triangulation-pool.js`: rebuilds each job's
group (real `Instance`s from flat `_xy` + nulled nodes) and cameras (with the
main thread's cached matrices installed) and runs the same
`triangulateAndReproject` from `./triangulation-core.js`. Messages: in
`{type:'cameras'}`, `{type:'solve', id, jobs}`; out `{type:'solved', id,
results}` (points3d buffers transferred) or `{type:'error', id, message}`.

**Imports from project modules.** `./pose-data.js` (`Camera`, `Instance`),
`./triangulation-core.js` (`triangulateAndReproject`).

**Imported by.** Spawned by `pose/triangulation-pool.js` via
`new Worker(new URL('pose/triangulation-worker.js', document.baseURI), {type:'module'})`.

---

### pose/id-switch-check.js

**Purpose.** The analysis behind Tracks ▸ **Check ID Switches (Body Size)…** and
**(Images)…**, which also run automatically after Track All / Track Frame Range
(`ui/id-switch-modal.js`). Flags close encounters between two tracked identities
where the animals leaving the encounter look more like each other's identity than
their own — a possible identity switch. Two cues through ONE machinery: body size
(3D bone lengths, cheap, no video) and appearance (embeddings of masked,
pose-aligned crops, supplied by the caller — `ui/image-embedder.js` in the app).
Pure — no DOM, no app state — so both run headlessly (the image check with any
embedding provider).

**Key exports.** `checkSizeSwitches(session, opts)` and
`checkImageSwitches(session, opts)` (async) -> `{ok, flags, changes, encounters,
identities, sampledFrames, closeDistance, threshold, fps, step, sampleHz, cue}`
(+ `bones` for size; + `imageHz`, `crops`, `cameras` for images) or
`{ok:false, reason}`; `markChangePoints(scored, o)` (the change-point step,
exported so calibration can re-apply thresholds to the same scores);
`fitSoftmax(X, y, n, D, K, opts)` (L2 multinomial logistic regression, Adam);
`fitPCA(X, n, D, k)` (randomized subspace iteration);
`KEYFRAME_GAP_TOLERANCE` (1.1);
`planKeyframeSamples(frames, keyframes, hasFrame)` -> `{decode, snapped, spacing,
keyframeGap, maxShift}` (which frame each image sample decodes in one camera — see
"Keyframe sampling" under `ui/image-embedder.js`); `SIZE_BONES`;
`REFERENCE_HZ` (15); `SIZE_CHECK_DEFAULTS` (`fps` REQUIRED, `sampleHz` 15,
`folds` 5, `gapSeconds` 10, `syncSeconds` 1, `threshold` -50, `continueBelow` 0,
`followSeconds` 60, `minTrackedSeconds` 60, `sepFactor` 0.65, `signal`, ...);
`IMAGE_CHECK_DEFAULTS` (+ `imageHz` 2, `threshold` -25, `pcaDims` 32,
`getEmbeddings` REQUIRED: `async (frame, items[{k, group}]) -> per item
[{camera, vector}]`, STARTED in increasing frame order with up to `inFlight`
(default 2; the image embedder asks for 8) in flight; optional `prepareFrames(frames)` (awaited once with the
sorted frames it will ask for) and `releaseFrames()` (always called at the end) let
the provider stream its video).

**The shared method.** Every round(fps / `sampleHz`)-th frame is a grid sample.
"Close" = body centroids within `sepFactor` x the median body extent (unit-free).
Tracklet = a run where an identity is apart from every other; encounter = the last
close sample of a close spell, scored when both identities' next tracklets start
within `syncSeconds`. A softmax is trained on the tracker's OWN labels with blocked
CV (each fold excludes `gapSeconds` either side) — on bone lengths (size), or per
camera on PCA-reduced embeddings, averaged over cameras (images, sampled every
round(sampleHz / imageHz)-th grid sample). Log-probabilities are normalised within
each frame across the identities present; an encounter's score = summed evidence
for the claimed labelling minus the exchanged one over the two following
tracklets. Each sample is weighted by `REFERENCE_HZ` / that cue's sample rate, so
scores are evidence per unit TIME and thresholds hold at any frame rate (25-120
fps tested within 0.4%). `opts.signal` cancels (AbortError).

**Change points, not raw flags.** The model can tell that the labelling on the
two sides of an encounter disagrees, not which side is right (it learns whichever
side covers more of the session). Per pair, a run of flagged encounters (starting
below `threshold`, continuing FORWARD while below `continueBelow`) yields one
change point: its start (`kind: 'onset'`) when it reaches the session end, else
the first unflagged encounter after it (`kind: 'end'`, in `changes`) when it
starts the session; both for a middle run of 2+. Other members are repeats
(`continues`). Each change point also names the other edge of its swapped
stretch, which is what fixing it swaps: an onset's `switchBackAt` (the pair's
encounter after the run — for a lone middle flag that encounter is no change
point of its own — or null when the run reaches the end) and an 'end''s
`switchedAt` (the run's first encounter, or null when the run starts the
session). A change point within `followSeconds` after another of a different
pair sharing an identity is its follow-on (`followOf`).

**Calibration (2026-10-03).** Size: on the 5-mouse tail-mark recording
(194366_05mice_flippers, 108k frames, 8 cameras) planted swaps AUC 0.95; the real
gate-off switch (frame 74,544) is an onset; the verified run gets 7 false change
points / 30 min. Images, calibrated with this code on DINOv2 embeddings of the
crops `ui/image-embedder.js` cuts: on the 5-mouse recording -25 gives 18 false
change points / 30 min and catches the real switch (image score -46; -50 misses
it, 0 gives 42); for the pairs size cannot separate (tail marks 1/2/3: size alone
5-19%) images catch 28-55%. On 6 proofread SLAP sessions with white, brown and
black mice (the 2022-10-07 sessions, which are 30 fps — scored at `fps: 30`), for
the similar-size, different-coat pairs (brown-black: size AUC 0.73, 5% caught at
-50) images reach AUC 0.92 and catch 46% at -25 (white vs dark 76%), at a 0.8%
false-flag rate per clean encounter. When both checks flag an encounter it was a
real swap 98% of the time (images alone 79%; none on the 5-mouse run with no
switches). Images remain weak for animals that look alike (same coat).
**Views per animal** (`imageCheckMaxViews`, default 3; recalibrated 2026-10-04):
embedding only each animal's 3 largest views matches all 8 — brown-black AUC
0.925, 48% at -25, 0.8% false flags, "Both" 98% real; 5-mouse: real switch scored
-66 (all views -46), similar-size pairs 1v3 44% (28%), 21 false change points /
30 min (18), 0 false "Both". 4 views is indistinguishable from all; 2 views starts
to cost (colour "Both" 92% real, false flags 1.1%).
**Sampling below 2/s does not work** (2026-10-04, checked because sampling only
at keyframes — every 250 frames, ~0.23/s on these files — would cut decoding
~250x). At 3 views per animal, 2/s -> 0.47/s -> 0.23/s: brown-black image AUC
0.925 -> 0.80 -> 0.75 (size alone 0.73), caught at -25 48% -> 32% -> 25%,
white-dark 75% -> 55% -> 41%, image-only flags real 77% -> 57% -> 51%; 5-mouse
false change points 21 -> 29 -> 40 / 30 min and the real switch missed at -25
below 2/s. The tracklets after an encounter are short, so they need dense samples.
The rate stays 2/s; cheaper decoding has to come from the recordings — which is
what keyframe sampling does: on recordings with a keyframe every 0.5 s each sample
moves to its nearest keyframe, <= 0.25 s away (`planKeyframeSamples`; see
"Keyframe sampling" under `ui/image-embedder.js`). **Moving samples by up to
±0.25 s does not change the result** (2026-10-04, 5-mouse recording, the real
model and check, 3 views; snapped = moved to frames 0, 30, 60, …; control =
every sample moved by a constant 16 frames, i.e. different frames with no
keyframe logic). Gate-on tracking (no real switch): planted-swap AUC 0.880
today / 0.880 snapped / 0.873 control, 43.5 / 43.8 / 44.4% caught at -25, change
points 10 / 7 / 9; encounter scores vs today correlate 0.982 (snapped) and 0.977
(control). Gate-off tracking: the real switch (74,544, id_2/id_3) is an onset in
all three (-94 / -99 / -112), AUC 0.812 / 0.805 / 0.807, change points 11 / 14 /
16, correlation 0.981 / 0.973. Snapping moves the scores less than the control
does, so its differences are which-frames-were-sampled noise. Harness:
`tests/e2e/_diag-image-keyframe-snap.mjs` (planted swaps cost no re-run: with
blocked CV an encounter's tracklet rows are never in their own fold's training
set, so swapping the two animals' labels after it turns its score S into exactly
-S).

**Imports from project modules.** `pose/pose-data.js` (`readPoint3d`).

**Imported by.** `ui/id-switch-modal.js`, `ui/image-embedder.js` (`planKeyframeSamples`, `KEYFRAME_GAP_TOLERANCE`).

**Coverage.** `tests/test-id-switch-check.mjs` (synthetic 3-animal sessions defined
in time: clean -> no flags; minority / majority switch -> onset / end change point;
25-120 fps invariance; images with synthetic embeddings catching a swap between
animals of IDENTICAL size that size misses; cancellation; PCA; failure reasons;
crop geometry of `ui/image-embedder.js`; `planKeyframeSamples`: sparse/unknown
keyframes move nothing, a keyframe every 30 frames moves every 32-frame sample
<= 15 frames, strictly increasing, untracked keyframes skipped, gaps up to 1.1x
the spacing qualify and beyond do not, a keyframe every 0.5 s at 100 and 50 fps),
`tests/e2e/image-keyframe-sampling.mjs`, `tests/e2e/size-switch-check.mjs`,
`tests/e2e/track-auto-size-switch-check.mjs`, `tests/e2e/id-switch-image-check.mjs`.

---

### pose/view-align.js

**Purpose.** The math behind View ▸ **Align Views to References…** (#226):
given two or more reference views the user has rotated the way they like,
compute the in-plane display rotation (`view.rotation` degrees) for every other
calibrated camera so the scene looks the same way round in all of them. Pure,
import-free (takes `Camera`-shaped objects), so it runs as-is in Node.

**Key exports.** `alignViewRotations(cameras, rotations, referenceNames, {center?})`
-> `{ok, center, rotations, skipped:[{name, reason}], disagreementDeg}` or
`{ok:false, error}`; `estimateSceneCenter(cameras)` (least-squares point closest
to every optical axis); geometry helpers `cameraCenterWorld`, `opticalAxisWorld`,
`projectToImage` (pinhole + `distortPoint`, `null` behind the camera),
`backProjectToWorldDir`, `screenUpImageDir`, `rotationForImageDir`, `wrapDeg`;
constants `UP_PULL`, `MAX_LINE_OF_SIGHT_ALIGNMENT`, `UPSIDE_DOWN_DEG`.

**The model.** Each reference contributes its screen-up PLANE (sight line +
screen-up direction at the scene centre) and its own 3D up vector. Per camera,
`U` minimizes `(1/N)Σ(U·n_j)² − 2λ U·(Σ w_jk up_j / Σ w_jk)` over unit vectors
(a 3x3 trust-region problem solved exactly in the eigenbasis), with
`w_jk = 1/φ³` by sight-line angle; the view is rotated so `U` projects
screen-up at the scene centre (through lens distortion). Distinct planes ->
their intersection (a ring of side cameras gets gravity up exactly);
coincident planes -> the proximity-weighted SUM of the references' ups (a
central top + central front pair: overhead views keep the arena layout, side
views keep gravity up — the issue's mockups).

**Notes / caveats.**
- **Two earlier models failed on the real rigs** and are documented in the
  header so they are not reintroduced: a single global plane intersection
  refused HardFight's and Mimica's natural pairs (both references lie in the
  rig's symmetry plane, so the planes coincide); carrying the reference's
  orientation along the shortest orbit twisted ring cameras up to upside down.
- **The tie-break must be the SUM of up vectors, not squared alignments** — a
  top view's up is horizontal and a front view's vertical; only their sum
  projects up in both. The squared form reported the two as "upside down".
- **Planes are not distance-weighted** (only the tie-break is): down-weighting a
  far reference's plane let the tie-break drag a clean intersection ~4° off.
- **At least two references.** With one, `U` is that reference's own up, which
  leaves ring cameras 10–20° off when it looks slightly down.
- **The scene centre is calibration-only** (optical axes), so it behaves the
  same on a lazily-loaded project whose frames are not resident; it refuses rigs
  whose axes are all within ~2° of parallel.
- A camera looking within 5° of `U` is skipped (its rotation would be noise), as
  is one with the scene centre behind it.

**Imports from project modules.** None.

**Imported by.** `ui/view-align-modal.js`.

**Coverage.** `tests/test-view-align.mjs` (synthetic rigs: ring, mixed heights,
distortion with an off-centre scene point, top-down, top+front in one plane,
blending, failure modes — every aligned view checked by projecting through the
real `Camera` and rotating the way CSS does) and
`tests/e2e/align-views-to-references.mjs` (the dialog in the real app). Real-data
check: `tests/e2e/_diag-real-align-views.mjs`.

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
  `state.trailLength` (node-trail frames) is an **accessor**, not a field: it
  reads `trailFrames(state.trailSeconds, state.fps)` (`ui/trail-presets.js`), so
  it follows the frame rate when a video loads or the FPS pill is edited, with
  no caller recomputing it. Setting it (tests and benches pin a frame count)
  stores `frames / fps` in `trailSeconds`. The pickers set `trailSeconds`.
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

**Imports from project modules.** `./trail-presets.js` (`trailFrames`,
`trailRate`), itself import-free.

**Imported by.** `pose/initialization.js`, `pose/triangulation.js`,
`pose/tracker.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `loading/session-loader.js`,
`ui/info-panel.js`, `ui/rendering.js`, `ui/identity-assignment.js`,
`ui/export-modals.js`, `ui/sessions-panes.js`, `ui/layout-controls.js`,
`ui/ui-wiring.js`, `ui/view-align-modal.js`.

**User-facing features.** Backs literally everything — session switching,
playback state, dirty tracking, multi-session UI.

---

### ui/color-by.js

**Purpose.** The toolbar's **Tracks / Identity** coloring setting
(`state.colorByIdentity`), settable from anywhere. The toggle's DOM and
redraws live in `ui/ui-wiring.js`, but `pose/tracker.js` also flips it — after
Track All the user wants to see IDs (#242) — and the tracker cannot import
ui-wiring (import loop; its Node tests stub UI modules). Dependency-free.

**Key exports.** `setColorByIdentity(state, on)` -> `true` if it changed
anything (the handler runs only on a change); `onColorByChange(fn)` —
registers the single change handler (ui-wiring: button highlight +
`drawAllOverlays` + `update3DViewport`). With no handler (Node tests) it only
sets the state.

**Imports from project modules.** None.

**Imported by.** `ui/ui-wiring.js` (registers the handler; the Tracks / Identity
buttons route through `setColorByIdentity`), `pose/tracker.js`.

**Coverage.** `tests/test-tracker-gui.mjs` (Track All flips it once, a second
run is a no-op, Track Frame leaves it) and `tests/e2e/track-all-switches-to-id.mjs`
(real toolbar: button highlight, 3D recolor, switching back).

---

### ui/browser-hints.js

**Purpose.** Browser-specific advice for features a browser has turned off.
Brave ships the File System Access API (`showSaveFilePicker`,
`showDirectoryPicker`, `showOpenFilePicker`) DISABLED by default while
identifying as Chrome, so in Brave saves fall back to an in-memory download
(risky for a large project, never saved in place), large exports must be
buffered in memory, and multi-session loading refuses. Measured on Brave 1.96
(Chromium 154): all three pickers are `undefined` by default and present with
`--enable-features=FileSystemAccessAPI`, the feature behind
`brave://flags/#file-system-access-api` ("File System Access API"). Safari and
Firefox can't enable the API, so they get no hint (existing messages stand).

**Key exports.**
- `isBrave()` — `navigator.brave.isBrave` present.
- `hasFileSystemAccess()` — save + directory pickers available.
- `fileSystemAccessHint()` — how to enable the API (paste
  `brave://flags/#file-system-access-api`, set Enabled, relaunch — or use
  Chrome/Edge); `''` unless Brave with the API off, so callers can append it.

**Imports from project modules.** None.

**Imported by.** `loading/session-loader.js` (multi-session load message),
`import-export/save-load.js` (`saveProjectSlp` download fallback status),
`ui/export-modals.js` (3D video + JSON export in-memory confirms),
`ui/overlay-export-modal.js` (overlay video in-memory confirm).

**Tests.** `tests/test-browser-hints.js`; verified end to end in real Brave
(default profile vs `--enable-features=FileSystemAccessAPI`).

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
`pruneOrphanIdentities(session, frameIndices)`, and the durable half shared with
the interactive deletes: `deleteTargetsFromStore(session, targets)` (→ `{durable,
errorRows, firstError, touchedFrames}`) plus the two target builders it is fed by
`ui/interaction.js` and `ui/ui-wiring.js`, `unlinkedTarget(frameIdx, ul)` and
`groupMemberTargets(frameIdx, group, camNames?)`.

**Every delete of a store-backed instance goes through `deleteTargetsFromStore`,
not only this dialog.** The Delete key / Edit ▸ Delete Instance / the toolbar's
"- Instance" (`InteractionManager._deleteSelected`) and the group context menu's
"Delete group" used to edit the RESIDENT frame alone, and on a lazy project that
is undone twice over: a windowed sweep (Track All, Triangulate All) or playback
eviction releases the predicted-only frame and re-hydrates the row, and the
streaming save writes the store rows of any camera-frame with no user instance
(`buildSessionRefGraph`'s overlay covers only camera-frames with one). So a
deleted prediction came straight back — confirmed on the real app by
`tests/e2e/sequence-lazy-workflow.mjs` cycle 5c, which drives all five shapes
(ungrouped, one view, Shift+Delete, the context menu, down-to-one-survivor) and
failed on every one before. The helper must run BEFORE the caller's memory edit:
it recognises the victims by their `_rawInstIndex` while they are still in the
group/frame, and renumbers the survivors around them. A target with no `rawIdx`
(an instance added this session) has no row and never reaches the store; an
eager session has no store and the call is a no-op apart from that renumbering.
It passes `deleteInstanceRows` an `only` map, so one keypress walks one
camera-frame instead of offering all ~2.7M rows of a real project to the
predicate.

**Vocabulary.** SLEAP's *video* scope is LUCID's **session** — every camera in a
session shares one frame index space, so a camera is a VIEW FILTER, not a frame
domain. The UI says **Grouped / Ungrouped** (the panel headers) and must never say
"Unlinked": in SLEAP an *unlinked prediction* is one with no `from_predicted`
back-link to a user instance, an unrelated concept that shares the word.

**The identity filter reads a TRACKLESS row's instance-level identity.**
`_identityMatches` resolves through the per-frame map for a tracked instance —
never the stale `group.identityId` (the #155/#168 class) — but a trackless
instance has no key in that map, so an ungrouped trackless row keeps its
identity on `Instance.identityId` (stamped by `unlinkGroup`; luc3d #201).
Reading only the map classified every such row as "no identity", which cuts
both ways and one of them destroys data: `identityMode:'none'` — the "delete
instances with no ID" sweep — MATCHED, and would delete, an animal the user had
plainly just labeled, while filtering FOR that identity skipped it. The matcher
now falls back to `inst.identityId` (`>= 0`) when there is no track, mirroring
`Session.getIdentityIdForUnlinkedInstance`; tracked rows resolve exactly as
before. Regression test: `tests/test-custom-delete-ops.js` "a TRACKLESS
ungrouped instance matches on its retained instance identity" (confirmed to
fail pre-fix).

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
wrong instances and `finalizeLazyFrameGroup` hydrates the wrong 2D — (1) and (2)
are `deleteTargetsFromStore`;
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

**Tests.** `tests/test-custom-delete-ops.js` (31 cases — its "interactive
deletes reach the store" suite drives `InteractionManager._deleteSelected` against
a recording stub store, and was confirmed to fail against the pre-fix
`ui/interaction.js`), plus `tests/test-custom-delete-store.js` for the store
primitive it drives, and `tests/e2e/sequence-lazy-workflow.mjs` cycle 5c for the
real app (sweep + save + reopen).

---

### ui/frame-counters.js

**Purpose.** Pure, DOM-free logic behind the status bar's **Labeled Frames**,
**Instances** and **Triangulated** counters; `updateFrameCounters`
(`ui/rendering.js`) is the DOM/scheduling half. Imports **no project modules**
— it only reads the `Session` it is handed — so a Node test drives it with real
`pose/pose-data.js` objects and a real `SioLazyLoader` (same contract as
`ui/custom-delete-ops.js`), and it bridges into both browser-suite runners.

**The counting rules** (unchanged from the old in-place loop): a frame is
labeled in the active camera if it holds a user instance, grouped or not, or a
GROUPED prediction — an ungrouped prediction is raw tracker output and does not
count; **Instances** counts user instances in that camera; **Triangulated**
counts frames with at least one `InstanceGroup` carrying `points3d`, in any
camera.

**Why it is not a walk of `session.frameGroups`.** On a lazy project that map is
the resident window, so the old loop reported a plausible, tiny number ("5789"
of 108,000 frames — the #194/#195 class). A count is now split in two:
- **Resident frames** are counted LIVE from their `FrameGroup`. They are what is
  on screen, they carry in-memory edits the store does not know about, and the
  current frame is one of them, so an edit shows up immediately.
- **Every other frame** comes from a per-frame **baseline** built without
  hydrating anything: Triangulated straight off `session.instanceGroups` (never
  windowed — it also catches a frame with 3D but no 2D `FrameGroup`, which the
  old loop missed on any project); Labeled / Instances from the columnar store
  via `lazyLoader.forEachInstanceRow({camera, start, end})` plus
  `instanceGroups` membership, **mirroring `finalizeLazyFrameGroup`**
  (`pose/triangulation.js`): a row whose in-frame offset is some member's
  `_rawInstIndex` is that member, with the MEMBER's type; a member with no
  `_rawInstIndex`, or one past the frame's last row, is dropped; every other row
  is ungrouped, with the store's type. That is what makes the baseline "what
  the frame would count as if it were visited now", and
  `tests/test-frame-counters.mjs` checks it against the real hydration path.

The baseline is per-FRAME, not a total, so resident frames can be taken back
out of it: `total − Σbaseline(resident) + Σlive(resident)`. That is
O(resident) per call and exact whatever the resident set is — scrubbing,
eviction and sweeps' window release need no rebuild. Only a change to frames
that are NOT resident (a bulk operation) does.

**Exports.**
- `residentFrameUserCount(fg, cam)` -> `-1` if the frame is not labeled in
  `cam`, else its user-instance count (one number, so the per-frame loop
  allocates nothing).
- `groupsHaveTriangulation(groups)` -> boolean.
- `createFrameCounterBaselineBuilder(session, cam, {tri}?)` -> `{step(budget),
  result}` — the baseline as a RESUMABLE build: ~100 ms at 108,000 frames x 8
  cameras, nearly all memory latency on each frame's groups (no reordering
  avoids it), so the caller spreads it over short tasks. `step` does about
  `budget` frames / `instanceGroups` entries and returns true when done.
  `result` = `{tri: {byFrame: Uint8Array, total}, cams: Map<cam, {byFrame:
  Int32Array, labeledTotal, usersTotal}>}`; the camera half is absent when the
  project is not lazy or its loader cannot enumerate rows (the worker-backed
  analysis-`.h5` loader — every frame with data is then resident). `tri: false`
  skips the 3D half. The session is read live between steps; a change mid-build
  can leave the result stale, and the caller rebuilds after changes anyway.
- `computeFrameCounterBaseline(session, cam)` / `computeLazyCameraBaseline(session, cam)`
  — the same, run to completion (whole baseline / camera half only).
- `countFrameCounters(session, cam, baseline)` -> `{labeled, instances,
  triangulated}`. With no baseline (or none for `cam`), Labeled / Instances are
  the old resident-only count.
- `nonResidentCameraCounts(session, half)` -> `{labeled, instances}` — the part
  of a camera half that `countFrameCounters` actually uses. Two builds that
  differ here saw a change to non-resident frames (a bulk operation), which
  `updateFrameCounters` takes as its cue to drop the other views' halves.

**Imports from project modules.** None.

**Imported by.** `ui/rendering.js`; bridged as `window.__FrameCounters` by
`tests/test-runner.html` and loaded as globals by `tests/run-node.js`.

**Tests.** `tests/test-frame-counters.mjs` (lazy: counts equal a fully-hydrated
count through the real `batchLoadLazyFrames`, with negative controls; residency
changes need no rebuild; a bulk change does; sliced == one-shot build),
`tests/test-bottom-bar.js` (the rules, on eager sessions, against this module
rather than a copy), and `tests/e2e/sequence-lazy-workflow.mjs`'s
`checkCounters` (the real status bar on a lazily reopened project: at reopen,
around Triangulate All and after Track All; confirmed to fail on the pre-fix
build, which showed "Triangulated: 3" with 3 frames resident).

---

### ui/frame-readout.js

**Purpose.** The controls bar's frame readout, left of the transport buttons:
the current time / duration on top, the current frame / total frames below,
every count with thousands separators.

    00:41.100 / 20:00.000
        1,234 / 36,000

**Key exports.** `formatFrameNumber(n)` (`36000` -> `"36,000"`, one cached
`Intl.NumberFormat('en-US')`, since it runs on every frame of playback),
`frameReadoutText(frameIdx, totalFrames, fps)` -> `{frame, total, time,
duration}` (pure; `frameIdx` null = the empty "0 / 0" state), `NO_TIME`
(`--:--.---`), and the DOM half: `showReadoutFrame(frameIdx)` (the per-frame
path — writes `#currentFrame` / `#currentTime`), `refreshReadoutTotals()`
(re-reads `state.totalFrames` / `state.fps`, writes `#totalFrames` /
`#totalTime` and re-times the frame on screen) and `clearReadout()`.

**Behaviour.**
- **It speaks the seekbar tooltip's language**, on purpose: the same separator
  and the same `formatTimestamp`, and the same time — a frame's START time,
  `frameIdx / state.fps`, at the playback FPS the FPS pill shows. So a click on
  the seekbar puts the tooltip's exact text into this readout. The duration is
  `totalFrames / fps`, so the last frame reads one frame short of it
  (`19:59.967 / 20:00.000` at 30 fps). An unknown frame rate (`state.fps` is 0
  while a multi-session load has no video yet) shows `NO_TIME` rather than a
  made-up clock.
- **Every writer of the readout goes through here** — `updateSeekbarVisual`,
  the inline frame editor and FPS pill (`ui/ui-wiring.js`), `updateFpsDisplay`
  (`pose/initialization.js`), the loaders (`loading/session-loader.js`,
  `import-export/slp-import.js`), session switch / removal
  (`ui/sessions-panes.js`) and New Project (`import-export/save-load.js`) — so
  the time row cannot fall out of step with the frame row. A new path that
  changes `state.totalFrames` or `state.fps` must call `refreshReadoutTotals`.
- The inline frame editor accepts the number the way the readout shows it:
  `"12,345"` seeks to frame 12,345 (commas and spaces are stripped).
- Layout (`.frame-display` in `styles.css`) is a three-column grid — current
  values right-aligned, totals left-aligned — so the two slashes stay in one
  vertical line whatever the digit counts. The time row is 0.85em of the frame
  row, both rows fit the 56 px controls bar at every width.

**Imports from project modules.** `./app-state.js` (`state`),
`./seekbar-tooltip.js` (`formatTimestamp`) — both import-free, so the text half
runs in Node.

**Imported by.** `ui/ui-wiring.js`, `ui/sessions-panes.js`,
`pose/initialization.js`, `loading/session-loader.js`,
`import-export/slp-import.js`, `import-export/save-load.js`.

**Coverage.** `tests/test-frame-readout.mjs` (the text: separators, start time
vs duration, hours, unknown fps, the empty state, and agreement with
`seekbarTooltipText`) and `tests/e2e/frame-readout.mjs` (real app: seekbar
clicks show the tooltip's text, the slashes line up and the readout fits the bar
at 1400 and 640 px, the frame editor takes `"12,345"`, an FPS edit re-times it).

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
  Its **unlinked** rows bucket via `session.getIdentityIdForUnlinkedInstance`
  rather than the track-keyed resolver — a trackless ungrouped instance keeps
  its identity on the instance (luc3d #201), so asking by track dropped exactly
  the instances an ungroup produced and this could not re-form what an ungroup
  took apart. Mirrors the identical fix in `ensureGroupsFromIdentities`
  (`pose/triangulation.js`), whose bucketing this duplicates.

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
- `slpIncludeGroupHtml({predId, reprojId, reprojRowId, reprojToggleId})`
  (module-private) — markup for the **Include** group shared by the Per-Session
  and By-Cam SLP export modals. Uses the app's standard `.toggle-switch` instead
  of raw checkboxes, and opens with a **note** (`.slp-inc-note`) reading
  "✓ UserLabels are automatically saved", above the two switches. Both modals
  have always written user labels
  (`instanceFilter.user` is hardcoded `true`), but with only "Predicted
  Instances" and "Reprojections" visible under a heading reading *Include*,
  users read the silence as an exclusion and asked whether their own labels were
  being dropped (luc3d #194).

  **A note, not a third always-on switch** (which is what this shipped as first):
  a control that cannot be operated misstates what the user can change, reads as
  "greyed out — am I losing something?", and leaves an inert input for a future
  caller to mistake for a real option. Nothing about user labels is stateful, so
  nothing about them is a control.

  Covered by `tests/e2e/export-include-user-labels.mjs`, which pins both the UI
  contract (the note comes first, contains no control at all, and the group has
  exactly two option rows; the option ids stay intact and each `.slider` really
  drives its checkbox — a `.toggle-switch` not wrapped in a `<label>` looks right
  and is dead) and the claim itself, by running the Per-Session export with
  Predicted and Reprojections both OFF and reading every user instance back out
  of the written `.slp`.
- `showSlpExportModal()` — single-camera SLP export modal (pick one camera per
  session, export to one file). **Retained but no longer wired to the File menu**
  — its old "Export SLEAP File" item was replaced by "Export SLEAP File Per
  Session" (`showSlpExportPerSessionModal`).
- `showSlpExportPerSessionModal()` — "Export SLEAP File Per Session": bulk export
  for the **open/active session only**. Lists every assigned-camera view in that
  session with a per-row **Download** checkbox (default ON; only checked rows are
  exported — an unchecked row gets `tr.slp-ps-off` and dims), camera, target
  directory, and versioned output filename
  `<stem>_vN.slp`, with an **Include** group built by `slpIncludeGroupHtml`
  (shared with By-Cam): the always-saved user-labels note, then **Predicted
  Instances** (default on) and **Reprojections** (emitted as
  UserInstance/PredictedInstance via a sub-toggle that enables with it). On
  Export it **always prompts** for a folder
  (`window.showDirectoryPicker` — it does not silently reuse a cached
  `state.exportDirHandle`) and writes one 2D `.slp` per camera
  into that camera's associated subdirectory (`state.cameraDirMap[cam] || cam`),
  via `exportSlpClientSide(...)`. Versioned names mean source `.slp` files are
  never overwritten. Falls back to flat `downloadBlob` downloads when the File
  System Access API is unavailable. Esc closes the modal.

  **The filename table is themed** (`.slp-ps-filename`, `.slp-ps-dl`). The output
  field and the Download checkbox were raw form controls, so they rendered as a
  white box in a system font and a white square on a dark modal. Both are now
  drawn from the app's tokens, the field in the monospace stack shared with
  `.data-table .mono` — real names here run ~67 characters
  (`cam-<stamp>-0000_h265_CRF30_denoised.mp4.predictions_v1.slp`), and monospace
  is what lines the `_CRF30` / `_vN` segments up down the column. The modal
  widened to `min(920px, 94vw)` so those names fit un-elided; it was `min-width:
  720px`, which beats `max-width` in CSS and so pushed the modal off-screen on a
  narrow window rather than shrinking. The field elides when unfocused and keeps
  the full name in `title` (the change handler re-syncs it).

  Row cells are **escaped** on the way into the markup (`esc()`). These rows are
  built by string concatenation, and camera names / directories / filenames all
  come from user files: an unescaped `"` in a filename closed the `value="…"`
  attribute early and the field came back **truncated at the quote** — asserted
  directly in `tests/e2e/export-include-user-labels.mjs`, which reproduces it
  against the pre-fix build.
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
  (`#slpByCamSkelWarning`) flags blocked columns. The **Include** group is the
  shared `slpIncludeGroupHtml` one (the always-saved user-labels note, then
  **Predicted Instances** / **Reprojections**); its two options become the `instanceFilter`
  (`{user:true, predicted, reprojected}`) passed to `exportSlpMultiSession`. The
  Reprojections row is **disabled as a unit** (`.slp-inc-row-disabled`) unless at
  least one session has reprojections (any `InstanceGroup.reprojectedInstances`
  populated, i.e. triangulation/tracking has run). Download All shows per-file
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
  **`Quality` picker** — the four shared tiers **480p (854×480) / 720p (1280×720)
  / 1080p (1920×1080) / 2160p (3840×2160)**, each label stating its pixel size.
  `V3D_RES` is **DERIVED from `RES_PRESETS`** in `ui/overlay-export-layout.js`
  (`refW` is the exact width here, since this viewport is always 16:9) and its
  H.264 level comes from that module's **`h264CodecFor`** — it used to be a
  hand-written per-tier table that had already drifted (it claimed level 3.0 for
  640×360 where the shared table says 3.1), and a wrong level only surfaces
  mid-export at one resolution. Live readouts for **Output** (the chosen tier
  echoed back as literal `W×H` + the Mbps it implies, so the resolution is on
  screen and not only inside the dropdown), **Duration**, **Exported Frames**
  (= selected range, updates with the Start/End nodes/fields) and **Estimated
  File Size** (the shared **`estimatedBytes`**, not a local copy of
  `bitrate × duration ÷ 8` — the same number decides whether the export streams
  to disk, so the readout and that decision cannot drift; formatted by
  `_fmtBytes`, recomputed on range/FPS/quality change); and
  Cancel / Export (all inputs disabled + playback stopped during an export).
  Export renders only the selected `[start, end]` range into the viewport at the
  chosen resolution (`renderer.setPixelRatio(1)` + `setSize(W,H)` + matching
  camera aspect), captures through an even-dimensioned 2D canvas, and encodes an
  `.mp4` through **`ui/video-encode.js`** (mediabunny), passing the resolution's
  H.264 level as `fullCodecString`. Timestamps are relative to the range start.
  When the estimated output exceeds `shouldStreamToDisk`'s threshold it asks for
  a save-file destination and **streams** to it (declining cancels the export,
  since buffering was the thing being avoided); a short clip just downloads.
  Requires WebCodecs — error status otherwise. Covered by
  `tests/e2e/export-3d-video.mjs`.
- `showTriangulateMultiFrameModal()` — frame-range triangulation modal.
- `exportLabels()` — JSON labels export.
- `exportPoints3dH5()` — points3d H5 export.
- `exportReprojH5()` — reprojection H5 export.

**Imports from project modules.**
- `./app-state.js` — `state`, `viewport3d`, `timeline`, `getActiveSession`.
- `./browser-hints.js` — `fileSystemAccessHint` (appended to the 3D-video and
  JSON-export "must be built in memory" confirms in Brave).
- `../pose/pose-data.js` — `InstanceGroup`, `UnlinkedInstance`, `pooledPoints3d`
  (Group by Identity / Track & Triangulate All store each solve in the slab pool).
- `../pose/triangulation.js` — `triangulateAndReproject`,
  `storeReprojectedInstances`, `frameHasGroupedUserInstances`,
  `loadAllLazyFrames`, `triangulateMultiFrameInstances`,
  `sessionHasCalibration`, `showCalibrationRequiredPopup`,
  `getInstanceGroupsForFrame`, `sweepLazyFrameWindows`,
  `resolveTriangulationMethod`, `findEquivalentPriorGroup`, `adoptPrior3d`,
  `triangulationMethodLabel` (the last four for the adopt-don't-downgrade rule).
- `./viewport3d.js` — `Viewport3D` (Export 3D Video modal).
- `./overlays.js` — `getTrackColor`, `getGroupColor` (Export 3D Video modal).
- `./rendering.js` — `drawAllOverlays`, `setReprojErrorVisible`,
  `showReprojectionsOnly`, `REPROJ_ONLY_NOTE` (both group-and-triangulate-all
  paths end Reproj-only — #243).
- `./info-panel.js` — `updateInfoPanel`.
- `../import-export/save-load.js` — `showLoading`, `hideLoading`,
  `setStatus`.
- `./loading-overlay.js` — `showLoadingProgress`, `yieldToPaint` (the
  "Grouping & triangulating" bar in `groupByIdentityAndTriangulateAll` — which
  Triangulate All ▸ DLT routes to — and `groupByTrackAndTriangulateAll`).
- `../pose/triangulation-pool.js` — `createGroupSolver`
  (`groupByIdentityAndTriangulateAll` solves its non-adopted groups on the
  worker pool; adoption and regrouping stay on the main thread).
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

**Instance tables layout: both fit a 300 px panel.** Grouped Instances is
Track / Identity · Views · Type · Error · unlink; Ungrouped Instances is
Track / Identity · Type · Points · Score, under one full-width header row per
camera. In both, a row's track and identity `<select>`s are STACKED in the
first cell, all `STACKED_SELECT_PX` (80) wide and left-aligned, track on top
(the Grouped row's dirty marker sits beside its track dropdown) — so a row is
two lines tall. Side by side, the dropdowns made Grouped ~390 px and Ungrouped
~324 px wide, and the Instances tab scrolled sideways inside the default 300 px
panel; stacked, plus 4 px cell padding scoped to the two tables in
`styles.css`, they need ~250 px and ~226 px against ~257 px of room once the
tab's 11 px scrollbar shows. The track dropdown is the FIRST select in that
cell — tests and code that look for it must say so (`select:first-of-type`).

Under each group that has reprojections, `updateFrameInfo` adds a row:
a REPROJECTION_COLOR dot and a "Reprojection" badge (`.badge-reproj`; it read
"Reproj") in the Track / Identity cell, titled "Reprojection of <name>"; the
reprojected view count (`n/cameras`) under Views; an EMPTY Type cell; the Error
dash; and the trailing empty cell — one cell per header column. The badge leads
the row rather than sitting under Type because the Type column then only has
to fit "Pred*", which is what makes the width above possible; the group's name
is on the row just above. (Before the stacked layout, this row was also one
cell short — built without an Identity cell when that column was added — so
every later cell sat one column left.) Covered by
`tests/e2e/info-panel-instance-tables.mjs`, which measures each table's fit as
its MIN-CONTENT width (the tables are `width: 100%`, so their rendered width
always equals their container and cannot show an overflow) and fails on the
old layouts.

**Instance-panel track/identity dropdowns.** Each grouped/unlinked instance
row has a track `<select>` and an identity `<select>`. Both selects include a
`(none)` option (value `-1`) and a `(+) New Track` / `(+) New Identity` option (value
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

**The Track `<select>` is built LAZILY** (`buildTrackSelect`, via
`ui/lazy-select.js`). Until the user presses or focuses it, it holds three
options — the head (`(none)`), the current track and `(+) New Track` —
and the full list is filled in on that first `mousedown` / `focus`, both of
which fire before the browser opens the list or acts on a key. An eager select
held an `<option>` per session track, and `updateFrameInfo` builds one per row
on every update: an un-tracked 8-camera prediction project with 863 tracks made
~35,000 options per update, the rebuild plus its style/layout took ~200 ms, and
because that outlasted `AUX_UPDATE_MS` the 10 Hz throttle in `ui/rendering.js`
let it run on EVERY frame — playback capped at ~5 fps, against 60 with the panel
hidden. Lazy, the same project plays at 59.9 new frames/s against 60 hidden
(`tests/e2e/_bench-playback.mjs`, `PREP=none SCENARIOS=full,noInfo`), with no
long tasks. What a closed select shows is unchanged — same value, same label,
nothing selected for an index past the track list — except its closed WIDTH,
which now fits three options rather than every track (capped by `max-width`
either way). The **Identity** selects stay eager: one option per identity, i.e.
per animal, they were never part of the measured cost, and a lazy select
ignores a scripted `.value` until focused, which
`tests/e2e/ungroup-retains-identity.mjs` and `ungroup-trackless-reopen.mjs`
rely on. Covered by `tests/test-lazy-select.js` (the helper: closed size
independent of the entry count; filled, option-for-option the eager list) and
`tests/e2e/info-panel-many-tracks.mjs` (the real `updateFrameInfo` with 10 and
1,000 tracks gives the same option count; a real click fills the list without
resizing the select; picking a track, `(none)` and `(+) New Track` still work).
That e2e fails on the eager build — 43,387 options and ~228 ms per update at
1,000 tracks, against 421 and ~7 ms.

**The panel tab bar is ONE horizontal scroller.** `setupPanelTabs` makes
`.panel-tabs` scroll sideways with every tab (Instances, Visibility, ID
Switches, Videos, Cameras, Skeleton, Session) always inside it, in markup
order. Each tab still sizes to its full name, never truncated.

This replaced a **"More ▾" overflow dropdown** that demoted whichever tabs did
not fit. At the default 300px panel width that was five of seven, so the
panel's own name for the thing the user was looking at was usually behind a
control they had to open first — and WHICH tabs were behind it moved as the
panel was resized, so the bar never looked the same twice. `layoutPanelTabs`
and every `.panel-tab-more*` rule are gone; do not bring them back.

Five things about it:
- **Three ways to scroll it, and a vertical wheel is one of them.** A trackpad
  over a ~31px strip gives a two-finger VERTICAL swipe, so the `wheel` handler
  takes whichever axis the gesture is actually on and applies it to
  `scrollLeft`. That steals nothing from the app's "one scroller per panel"
  rule: the bar sits OUTSIDE `.panel-tab-content`, which is the panel's one
  vertical scroller, so a vertical wheel here moved nothing before. It
  `preventDefault()`s only when the bar actually moved, so a swipe past either
  end is still the page's.
- **Click-and-drag has a 4px threshold, and a real drag SUPPRESSES the click.**
  A row of buttons that can be dragged will otherwise switch tabs every time
  the user flicks it — the pointerup that ends a drag still produces a click on
  whatever tab it landed on. The suppression is a capture-phase `click`
  listener on the bar (capture, so it runs before the tab's own handler rather
  than after it has already switched), and it is cleared on the next
  `pointerdown` so a drag that never produced a click cannot eat the press
  after it. Pointer capture is taken only once the threshold is crossed:
  capturing on every press re-targets the plain click that follows one. Touch
  pointers are skipped outright — `overflow-x: auto` + `touch-action: pan-x`
  already give them native momentum panning, and driving `scrollLeft` on top
  would move the bar twice per gesture.
- **Selecting a tab scrolls it into view**, by hand rather than with
  `scrollIntoView`, which walks every scrollable ancestor and could scroll the
  app's layout out from under it. This is what keeps `openIdSwitchPanel`
  (`ui/id-switch-modal.js`, which just `.click()`s the button) from leaving the
  active tab off-screen — an active tab nobody can see reads as no tab being
  active. `.panel-tabs` is `position: relative` precisely so each tab's
  `offsetLeft` is measured in the scroller's own space.
- **The edge fades are the only affordance**, toggled by the `scroll-left` /
  `scroll-right` classes and drawn with `mask-image` (painted in the element's
  own box, so it stays pinned to the edges while the tabs move underneath, and
  costs no extra element — a gradient overlay inside a scroller would scroll
  away). The scrollbar is suppressed: the strip is ~31px tall and a horizontal
  bar under it would sit on the active tab's 2px underline. A `ResizeObserver`
  recomputes them, since resizing the panel changes WHETHER it overflows.
- **`user-select: none` on the bar** — the documented exception for "a surface
  whose job is to be dragged". Without it a drag smears a selection across the
  tab names.
Covered by `tests/e2e/panel-tabs-scroller.mjs`.

**The Videos tab's two buttons are wired at SETUP, not per-session.**
`setupVideosTab()` (called once from `pose/initialization.js`) installs the
`#btnLoadVideos` → `handleLoadVideos` and `#btnRemoveVideo` → `removeVideoFile`
handlers. They used to be assigned inside `updateInfoPanel`, which returns early
when `state.session` is null (and while the panel is collapsed) — so on a
freshly-opened app, exactly when you reach for **Load Videos**, the button
carried no handler at all and clicking it did nothing, while `File ▸ Load
Videos…` kept working because *that* is wired at setup (luc3d #216). Nothing in
the wiring reads `state`, so it has no business in a per-session rebuild.
Two details ride along:
- The button is **`Load Videos`**, named after the menu item it duplicates, and
  **`Remove Video`** (singular — it acts on the one selected row).
- The selected row is held by **identity** (`selectedVideoFile`), not by row
  index. Both buttons rebuild the table, and an index into the OLD table names a
  different video in the new one; `populateVideosTable` clears the selection,
  disables `Remove Video` and resets the detail block on every rebuild, so the
  button can never act on a row that is no longer on screen.
Covered by `tests/e2e/videos-panel-buttons.mjs`.

**Key exports.**
- Tab control: `setupPanelTabs`, `setupVideosTab`.
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

**Collapsed panel does nothing.** `updateInfoPanel` and `updateFrameInfo` both
stop early when `isInfoPanelVisible()` (`ui/panel-visibility.js`) is false,
marking the panel stale so `refreshInfoPanelAfterShow` (`ui-wiring.js`) rebuilds
it once on re-show. This is not a micro-optimization: `updateFrameInfo` runs on
every frame (throttled to 10 Hz during playback) and rebuilds the
per-instance × per-node × per-camera breakdown plus both instance tables with a
fresh `<select>` per row, and `updateInfoPanel` additionally calls
`populateVideosTable`, which walks EVERY frame of the session per video row.
Three things deliberately stay outside the gate:
- **The status bar**, which is NOT part of `#infoPanel` and is always on
  screen. `updateFrameInfo`'s tail writes `#statusError` and calls
  `updateFrameCounters()`, so gating the whole function would silently freeze
  the bottom bar. Two private helpers split it: `aggregateReprojectionError`
  (the three summary numbers — arithmetic over values already in
  `state.triangulationResults`, cheap) runs first and unconditionally, then
  `updateStatusBarForFrame` runs on both the hidden and the visible path.
  `updateInfoPanel`'s hidden branch calls `updateFrameInfo` for the same
  reason. Only the panel's own DOM is skipped. `updateStatusBarForFrame` does
  **not** call `updateFrameCounters()` while `state.isPlaying`: those counters
  walk every resident frame group (every frame of an eager project, ~8–9 ms at
  36,000 frames; a lazy project adds a cached baseline), are independent of the
  current frame, and recomputing them on the 10 Hz playback updates stalled the
  video-frame callback enough to drop frames
  (`tests/e2e/_bench-playback.mjs`). `VideoController.stopPlayback` redraws
  with `isPlaying` false, which refreshes them on stop.
- The reprojection **solve** in `ui/rendering.js`'s per-frame fill. The canvas
  overlays, the 3D viewport and the `.slp` export all read the same
  `_grp.reprojections` / `reprojectedInstances` it produces, and the fill only
  fires once per group — skipping it for a hidden panel would blank the canvas
  markers and permanently starve the panel of numbers it could never recompute.
  Only the panel's *consumption* of `state.triangulationResults` is skippable.
- `rememberSkeleton(state.session.skeleton)`, which the gated branch still
  calls. It is `populateSkeletonTable`'s one non-DOM side effect, and
  `buildRememberedSkeleton()` feeds `ensureSession` — a skeleton loaded while
  the panel was hidden must not leave the next new session with a stale one.

**Collapsible Skeleton sections.** The Skeleton tab's **Nodes** and **Edges** are
`<details class="info-section info-collapsible">` (`index.html`), so either table
can be folded away — the Nodes list runs to one row per node and otherwise pushes
Edges off the bottom of the panel. Native `<details>`/`<summary>` rather than a
hand-rolled toggle, matching `ui/settings-modal.js`'s `buildSection`: the
disclosure is keyboard-operable and screen-reader-labelled for free, and
`ui/keyboard-target.js` already treats a focused `SUMMARY` as owning Space/Enter,
so toggling a section cannot fall through to the transport's Space shortcut.
`populateSkeletonTable` keeps the `#skeletonNodesCount` / `#skeletonEdgesCount`
summary badges in sync (a collapsed section still says how much it hides);
`import-export/save-load.js`'s clear-project path resets them to `0` alongside
the tbodies. `setupSkeletonEditing` wires `persistSectionState` on both, storing
open/closed in `localStorage.skeletonSectionsOpen` — browser-local display taste,
never project state, so it does NOT go in the `.slp`; every access is
try/caught, and a browser that refuses storage just gets the markup's default
`open`. This is the collapsible-section remedy the "no scroll-within-scroll"
convention in `CLAUDE.md` prescribes.

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
- `./panel-visibility.js` — `isInfoPanelVisible`, `markInfoPanelStale`.
- `./section-state.js` — `persistSectionState` (Skeleton ▸ Nodes / Edges,
  under the `skeletonSectionsOpen` key).
- `./lazy-select.js` — `buildLazySelect`, behind `buildTrackSelect` (both
  instance tables' Track `<select>`s).
- `./id-switch-modal.js` — `refreshIdSwitchPanel`: `updateInfoPanel` re-renders
  the ID Switches tab (and its seekbar markers) for the active session.
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
  "(none)" on a trackless row clears `Instance.identityId` directly, there being no
  map entry to clear). The unlinked row's ID `<select>` pre-selects from
  `getIdentityIdForUnlinkedInstance` (per-frame map entry for a tracked row,
  instance-level retained identity for a trackless one), which is why
  `Session.unlinkGroup` has to retain the
  disbanded group's identity in the map / on the instance for the row to read as anything
  but "(none)". (Both tables' "no track" / "no identity" option reads "(none)"; the
  Ungrouped table's used to read "—".)
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
top of the Visibility panel (above User / Predictions / Reprojections).
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
  `onMouseLeave`/`onWheel`, `onKeyDown`, `_addNewInstance` (used by smart-add;
  lays out a new skeleton via an inline BFS fan-out from the highest-degree
  root, with a vertical-line fallback when there are no edges).
- `isInteractiveClickTarget(target)` — used by other UI to skip
  click-through on form controls.

**Plane annotation (View ▸ Define Planes).** A `PlaneInstance`
(`pose/plane-data.js`) is edited through the SAME code path as a UserInstance —
`hasPoint`/`getX`/`getY`/`setPoint`/`numNodes` is the whole interface the drag
path needs, and PlaneInstance inherits all of it — so plane editing cannot
drift from pose editing. Added surface:
- `findNearestPlaneNode(vx, vy, viewName)` — mirrors `findNearestNode`
  (nodes first, then edges; an edge hit returns `nodeIdx: -1` for
  `_resolveNearestNode`), with the same zoom-corrected thresholds. It considers
  only the indices `getPlaneNodeIndices(viewName)` reports as SHOWN there
  (`planeNodeIndexSet`, also passed to `_resolveNearestNode`'s new `allowed`
  argument): a plane instance covers the feature's whole node pool, so without
  the filter a node whose only plane is not placed on this view would take a
  click while drawing nothing.
- `selectPlane(plane, nodeIdx)` + `selectedPlane` / `selectedPlaneNodeIdx` /
  `hoveredPlaneNode`. A plane selection and a pose selection are **mutually
  exclusive** (each `select*` clears the other) so exactly one thing is ever
  reported as selected; `clearSelection()` clears both.
- The `beginPlaneDrag(viewName, nodeIdx, wholePlane)` callback, asked once at
  mousedown. `allowed:false` refuses the drag (a PINNED node; the feature puts
  the reason in the status bar) while the click still SELECTS, so the node stays
  reachable for un-pinning. Its `indices` become `dragInfo.indexFilter`, which
  both `_onDragMove` and `_onDragUp` honour in whole-instance mode — an
  Alt+drag must carry the grabbed plane's nodes and leave every other plane's
  where they are, and the pool-wide instance makes that a real distinction.
- The `isPlaneDataLocked()` callback, asked in the right-click branch before a
  plane node is nulled. True while something else is reading plane geometry and
  must not have it change underneath (the Set Angle dialog, which stays open
  over a live 3D view); nulling a plane node invalidates its 3D, so it is a
  geometry edit like a drag. Deliberately NOT folded into `isPlaneEditMode`,
  which gates hit-testing too: with that false a click meant for a plane corner
  would fall through and grab a pose node instead. Plane nodes keep selecting
  and hovering while locked; only the mutations are refused. Like
  `beginPlaneDrag`'s `allowed:false`, the callback puts the reason in the status
  bar itself — this module cannot explain a refusal it does not own, and a
  silent one reads as a broken click.
- `onPlaneChanged(planeInstance, movedIndices, {moved})` — the second argument
  names the node indices the edit touched (`[nodeIdx]`, the alt-drag's filter, or
  null for "unknown"), so the feature can invalidate exactly those nodes' 3D.
  `moved` separates a DRAG (`true`) from a right-click null-toggle (`false`):
  only a drag means the user positioned those points, which is what promotes a
  REPROJECTED corner to a real observation. Toggling one off says nothing about
  where it is, so it must not.
- `_startDrag`'s trailing `plane` argument, carried on `dragInfo.plane`.
  Planes live outside `frameGroups`, so unlike a grouped instance they cannot
  be re-resolved from `instanceGroupIdx` mid-drag and are held by reference.
  `onMouseUp` skips its usual `instance.type = 'user'` promotion for a plane —
  promoting it would put a PlaneInstance into the pose pipeline's vocabulary.
- Gestures: click to select, drag a node, **Alt+drag** to translate the whole
  plane (reusing `altDragSource`'s `mode: 'instance'`), **right-click** to
  toggle a node off into `nulledNodes`.
- The node hit radius comes from the `getPlaneNodeSize` callback (the shared
  Plane Appearance ▸ Node Size slider), so what you can grab is always what you
  can see; `planeHitRadius` is the fallback when no callback is supplied.

**Everything plane-related is gated on `_planeEditable()`** — the
`isPlaneEditMode` + `getPlaneInstances` callbacks. Outside "Defining Plane
Mode" every plane branch is dead, so plane nodes can never compete with pose
nodes for a click during normal annotation; with no callbacks wired the whole
feature is inert. Inside the mode, planes are checked FIRST on mousedown/hover
so a plane node on top of a pose instance is still grabbable, and a MISS falls
through to the normal handling so pose editing keeps working.
`tests/e2e/define-plane-mode.mjs` pins both directions of that gate.
**Deselecting an unlinked instance clears the Delete target too.** Two fields
track an unlinked selection: `assignmentSelection` (what the amber ring and the
Ungrouped Instances row highlight read) and `selectedUnlinked` (what
`_deleteSelected` acts on). Clicking an already-selected unlinked instance
toggles it out of the first — `addToAssignmentSelection`'s toggle-off branch,
reached from `onMouseUp` via `_unlinkedWasSelected` on a plain click with no
drag — and used to leave the second pointing at it. The instance was then still
armed for **Delete** with nothing anywhere on screen saying so: no ring, and no
highlighted panel row. The toggle-off branch now clears `selectedUnlinked` when
it names the same instance, so the two cannot drift apart. (This is also why
`drawUnlinkedInstances`' `selectedUnlinkedId` option stays deliberately undrawn:
a click always adds to `assignmentSelection`, so the amber ring already marks
the selection. It is kept as the hook for ever distinguishing the PRIMARY,
Delete-target selection within a multi-camera one.) Regression tests:
`tests/test-assignment.js` "Assignment - deselect clears the Delete target too"
— the state transition and a full click-click through real `MouseEvent`s, both
confirmed to fail pre-fix.

**Alt + wheel rotates a whole instance about the node under the cursor**
(issue #198), the counterpart to Alt+drag's whole-instance translate. Ported
from SLEAP's `QtNode.mousePressEvent`/`wheelEvent`
(`sleap/gui/widgets/video.py`), including its rate: **6 degrees per wheel
notch**, clockwise on a scroll up. One `_applyInstanceTransform` does the
rigid rotate-then-translate for every path, always recomputed from a points
snapshot taken when the gesture started, so a long burst cannot accumulate
drift and a rotation composes with a simultaneous drag.

Two entry points, because SLEAP's has a trackpad problem:
- **Button held (SLEAP's own gesture).** Alt+press a node starts the existing
  whole-instance drag; `_onDragWheel` then turns it about `dragInfo.pivot` (the
  grabbed node — SLEAP's `setTransformOriginPoint`). Document-level and in the
  capture phase, so the cursor may wander and the rotation still beats
  wheel-to-zoom. A pure rotation never clears the drag deadzone, so `onMouseUp`
  treats a non-zero `rotationDeg` as a change in its own right.
- **No button (LUCID addition).** `onWheel` on the overlay canvas handles
  Alt+wheel while merely hovering a node. SLEAP requires the button down, which
  on a macOS trackpad means click-and-hold while two-finger scrolling; hold-free
  Alt+wheel is what makes the feature usable there. The gesture latches in
  `_rotateGesture` and commits on a ~200 ms idle
  (`_scheduleRotateCommit`/`_commitRotateGesture`), on the next click, or on
  `detach()` — so `onNodeMoved` (dirty flag, re-triangulation, 3D rebuild) runs
  once per burst rather than per tick, exactly as a drag commits once on
  release.

**The lettering does not turn with the skeleton.** Only the points move. Every
piece of label text — node names and the track/identity pill, in
`drawInstanceLabels` and `drawUnlinkedInstances` — is drawn inside
`ui/overlays.js`'s screen-aligned `beginUprightFrame`, which cancels the
VIEW's rotation (issue #162) and never sees the instance's; what does follow
the turned skeleton is the label's *placement*, since `computeLabelOffset`
picks the widest gap between a node's edges. Pinned by the `Instance Rotate -
node names stay horizontal` tests, which read the canvas transform in force at
each `fillText` and assert transform-rotation + view-rotation is zero — they
were confirmed to go red against a deliberately injected label rotation, so
they pin the invariant rather than just current behavior.

`wheelNotches` folds `deltaMode` in (Chrome ~100 px/notch, Firefox 3
lines/notch) and **ignores `deltaX`** — SLEAP sums Qt's x and y deltas, but on a
trackpad the incidental horizontal component then fights the vertical one.

**Holding Alt suspends wheel-to-zoom outright.** A wheel with no Alt is left
un-consumed so plain scroll still zooms, but an Alt+wheel is ALWAYS taken
(`_consumeWheel`) — even over empty canvas, or over a reprojected instance,
where there is nothing to turn. Zoom cannot be allowed to fire *while a
rotation is in progress*: a scroll that strayed off the skeleton would yank the
view out from under it. This takes TWO guards, because they cover different
ground and each is pinned by its own assertion:
- `onWheel`'s `_consumeWheel` handles the wheel landing ON an overlay canvas.
- `loading/video.js`'s wheel handler returns early on `e.altKey`, which is the
  only thing covering the **letterbox margin** of a `.video-cell` — a video
  narrower or shorter than its pane leaves cell area with no overlay canvas
  under the cursor at all, so `onWheel` never runs there. Removing this line
  alone was confirmed to turn the e2e's margin check red while the
  on-canvas one still passed.

Releasing Alt brings zoom straight back; nothing is latched to a mode.
Within a gesture the rotation IS latched, though, so a stray Alt+wheel
off-skeleton keeps turning the same instance about the same pivot (SLEAP
reaches the armed node wherever the pointer is) rather than doing nothing —
once the gesture lapses, the same scroll does nothing at all.

Coverage: `tests/test-instance-rotate.js` (31 assertions against the real
manager) and `tests/e2e/alt-wheel-rotate-instance.mjs`, which drives real
Chromium wheel input at the real app and asserts rotation and zoom never both
fire, including the letterbox margin and the return of zoom on Alt release.

**Zoom-aware thresholds.** `_displayToVideo(state, viewName)` returns how many
video pixels span one CSS pixel on screen given the view's current `zoom.scale`.
Hit-test padding (`findNearestNode`/`findNearestUnlinkedNode`) and the drag-start
deadzone (`_onDragMove`, ~3 CSS px) multiply by it so they stay constant on screen
— previously the deadzone was a fixed 3 video px, which forced a large on-screen
drag at high zoom and blocked fine node adjustments.

**A delete is a STORE delete first (`_deleteSelected`).** The Delete key, Edit ▸
Delete Instance and the toolbar's "- Instance" all land in `_deleteSelected`,
which now calls `deleteTargetsFromStore` (`ui/custom-delete-ops.js`) with the
selected ungrouped instance (`unlinkedTarget`) or the deleted group members
(`groupMemberTargets` — the one view, or every view for Shift+Delete) BEFORE it
edits the frame. On a lazy project the columnar store is the source of truth, and
the resident-only edit it used to make did not survive: a windowed sweep or
playback eviction releases a predicted-only frame and re-hydrates the row, and the
streaming save writes the store rows of any camera-frame with no user instance —
so the deleted prediction came back, before or after a save. The store call goes
first because it identifies the victims by `_rawInstIndex` while they are still in
the group/frame and renumbers the survivors around them. The camera of an
ungrouped delete is the instance's own (`ul.cameraName`), not
`lastInteractedView`. The in-memory semantics (auto-ungroup to a lone survivor,
mixed→user promotion, partial deletes keeping their 3D) are unchanged; an eager
session has no store, so it deletes exactly as before. Covered by
`tests/test-custom-delete-ops.js` ("interactive deletes reach the store") and
`tests/e2e/sequence-lazy-workflow.mjs` cycle 5c.

**Imports from project modules.**
- `../pose/pose-data.js` — `Instance`.
- `../pose/triangulation.js` — `getOrComputeReprojectedInstance`.
- `./keyboard-target.js` — `shouldIgnoreShortcut`.
- `./custom-delete-ops.js` — `deleteTargetsFromStore`, `groupMemberTargets`,
  `unlinkedTarget` (import-free itself, so this adds no cycle).

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`.

**User-facing features.** Click-to-select skeleton nodes, drag to move
keypoints, Alt+drag to move a whole instance, Alt+wheel to rotate one about a
node, double-click to convert predicted → user, shift-drag to add
to manual-assignment selection, right-click to null/restore nodes,
keyboard shortcuts (delete, alt-drag clone, etc.).

**`onKeyDown` guards with `shouldIgnoreShortcut`** (`ui/keyboard-target.js`)
rather than its own `tagName === 'INPUT'` test, so `Delete` / `n` / `c` survive
a click on a checkbox (issue #163).

**Grouping/ungrouping shortcuts.** `onKeyDown` handles only the legacy `c`
confirm-group alias (creates a group from a ready ≥2 assignment selection).
The primary group (`Shift+G`) and ungroup (`Shift+U`) shortcuts are
**catalog-dispatched** and wired in `ui/ui-wiring.js` (`setHandler`); ungroup
delegates to that module's `unlinkGroup` (the complete path: data-model
`Session.unlinkGroup` + triangulation purge + overlay/3D/timeline/info-panel
refresh). The old incomplete `InteractionManager._unlinkSelectedGroup` helper
was **removed** (it had no production callers).

---

### ui/keyboard-target.js

**Purpose.** Decide whether a keystroke belongs to the focused control or to the
app — the single guard every global `keydown` handler calls (issue #163).

The guard used to be one line, copied into ten separate handlers:

```js
if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
    e.target.isContentEditable) return;
```

meaning "don't steal keys from someone who is typing". But `tagName` is `INPUT`
for a **checkbox** too — and for a radio, a range slider and a file picker. So
the moment the user clicked the User / Predicted / Reprojections / Errors toolbar
checkbox, that test went true for every keystroke and **every shortcut in the
app went dead**, not just the one the checkbox wanted. Spacebar toggled the
checkbox instead of playing the video, and the only cure was to click back onto
a video pane.

**The two halves of the fix.**
1. *Ask what the control consumes, not what tag it is.* A text field consumes
   the whole alphabet, so it blocks everything. A checkbox consumes exactly
   `Space`; a range slider exactly the arrows and `Home`/`End`; a button `Space`
   and `Enter`. Everything else stays live, which is also what keeps the app
   usable from the keyboard: Tab to a checkbox and you can still step frames.
2. *Give focus back after a POINTER click.* Fixing the guard alone leaves
   `Space` genuinely ambiguous, because a focused checkbox does own it — so
   play/pause would stay broken for exactly the interaction the issue describes.
   `installFocusRelease` blurs an activate-me control once a pointer has
   activated it, since the click already delivered everything focus was good
   for. **Keyboard focus is deliberately left alone** (detected via
   `:focus-visible`): tab to the checkbox, press `Space`, still get a toggle.

**The third owner: the browser.** A keystroke can belong to neither the focused
control nor the app. `Mod+C` is bound to Copy selected instance, and the catalog
dispatcher `preventDefault()`s every binding it matches — which cancels the
keydown's `copy` default action too. Text selected anywhere outside a field — a
panel, a modal, the status bar's error message — could therefore be highlighted
and **never copied**: the keystroke went to the pose annotation instead and left
"No instance selected to copy" in the status bar. `shouldIgnoreShortcut` now
hands the copy/cut chord back **whenever a selection exists**, and only then, so
Copy selected instance is untouched in the normal annotating case. Cut is
included with copy; **paste deliberately is not** — nothing about having
selected some text says the user wants to replace it.

**Key exports.**
- `shouldIgnoreShortcut(e)` — the guard itself: the clipboard-chord rule above,
  then `isTextEntryTarget(e.target) || targetOwnsKey(e.target, e)`.
- `hasTextSelection(doc)` — true for a non-collapsed selection with text in it.
  The whole read is wrapped: a selection inside a shadow root or a cross-origin
  frame can throw, and the honest answer there is "none I can speak for".
- `isTextEntryTarget(t)` — free-text targets, which block every shortcut:
  `<textarea>`, `contenteditable`, the text-ish `<input>` types, `role=textbox`
  /`searchbox`/`combobox`, **and `<select>`** (it uses the arrows, `Enter` and
  letter typeahead — nearly the whole shortcut alphabet, so treating it like a
  text field is simpler and safer than enumerating what it keeps). An `<input>`
  with a missing or unknown type lands here too, because the DOM reports `text`
  for both and `text` is the safe default.
- `targetOwnsKey(t, e)` — whether THIS key is the focused control's own. A
  modifier chord never is, so `Mod+S` still saves while a checkbox has focus.
- `isTransientFocusControl(t)` / `releaseTransientFocus(el, doc)` /
  `installFocusRelease(doc)` — the focus-release half. Text fields, selects and
  sliders are never released: focus there is the beginning of an interaction,
  not the end of one.

`:focus-visible` rather than `event.detail` is what separates pointer from
keyboard: a click on a `<label>` forwards a **synthetic** click to its control
with `detail: 0`, indistinguishable from a keyboard one — and every toolbar
checkbox in `index.html` is wrapped in a label.

The release listener defers its `blur()` by a turn of the event loop, for two
reasons: a `<label>` click forwards to its control and focus lands *after* the
listener runs, and `input`/`change` fire as part of the activation behavior, so
blurring mid-dispatch would be reaching into someone else's event.

It is registered in the **capture** phase (issue #230). Delegated on `document`
in the bubble phase, it never saw a click from any control whose own handler
calls `e.stopPropagation()` — as the Triangulate / Triangulate All split
buttons do (`wireTriDropdown`, `ui/ui-wiring.js`), so their click does not also
close the toolbar menus. Those buttons therefore kept focus after a pointer
click: they rendered as "selected", and `targetOwnsKey` handed `Space` and
`Enter` to the focused button instead of to the app, killing play/pause until
something else was clicked. Capture runs before any target handler can stop the
event, so a control cannot opt itself out of focus release by accident. The
blur is still deferred, so listening earlier changes nothing about *when* focus
is released.

**Imports from project modules.** None — every predicate reads only
`tagName` / `type` / `role` / `isContentEditable` off its argument, so it
bridges into both test runners and unit-tests against plain object stubs.

**Imported by.** `ui/ui-wiring.js`, `ui/settings.js`, `ui/interaction.js`,
`loading/video.js`.

**Tests.** `tests/test-keyboard-target.js` (the predicates, both runners),
`tests/e2e/checkbox-focus-hotkeys.mjs` (the real app: click the checkbox, press
Space, get playback; Tab to it and Space still toggles) and
`tests/e2e/copy-panel-text.mjs` (the clipboard rule, against the REAL clipboard,
with the no-selection negative control) and
`tests/e2e/triangulate-button-focus.mjs` (the capture-phase half: the two
Triangulate buttons, plus a synthesized button that stops propagation, so the
rule is pinned rather than those two ids).

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

### ui/loading-overlay.js

**Purpose.** Owns the full-window loading overlay (`#loadingOverlay`) and its
determinate progress bar — the ONE progress component shared by Track All,
Triangulate All (all three routes), Group by Identity/Track, and anything else
that runs a chunked main-thread loop behind the overlay.

**Key exports.**
- `showLoading(msg)` — indeterminate form (spinner + text); hides the bar.
- `showLoadingProgress(label, done, total, { step, steps, detail, unit })` —
  writes the standard `"<label>: done/total frames (pct%)…"` line and drives the
  bar (`#loadingProgress` / `#loadingProgressFill`, `role="progressbar"`). The
  line under the bar (`#loadingSubstatus`) carries `Step k of n` (only when
  `steps > 1`) and `detail` (method, group counts), so the main line keeps one
  format everywhere. A new stage (bar hidden, or the fraction moving backwards)
  snaps instead of animating. `pct` is floored, so 100% means done.
- **Time remaining** — every `showLoadingProgress` call also updates a second
  text line under the main one (`#loadingEta`): "Estimating time remaining…"
  until the stage has run 1.5 s and covered 1%, then "About 1 min 10 s
  remaining" (rounded to 5 s under 10 min, to the minute above; "… in this step"
  when `steps > 1`), cleared at 100%. The rate is measured over the last 10 s of
  the CURRENT stage (a new label/step/total, or progress moving backwards,
  starts a fresh estimate), so it follows work that speeds up or slows down
  rather than lagging like a whole-run average. `estimateRemainingMs(samples,
  done, total)` and `formatRemaining(ms)` are exported for tests, as is the
  clock hook `__setLoadingOverlayClock(fn)`. The raw estimate is exposed as
  `#loadingEta[data-ms]`, which the bench reads to score accuracy.
- `hideLoading()` — hides the overlay and resets the bar.
- `createProgressPacer(intervalMs = PROGRESS_INTERVAL_MS)` → `{ due(), yield() }`.
  `due()` is true at most once per interval (a `performance.now()` check, cheap
  enough to call every iteration); `yield()` = `yieldToPaint()`, after which the
  interval restarts (so it measures WORK time between yields).
- `yieldToPaint()` — resolves after the browser has painted: rAF then a task
  queued after it (a bare `setTimeout(0)` can fire before the next display frame,
  leaving the overlay unpainted for another whole chunk), with a 100 ms timer
  fallback for throttled rAF. A hidden tab yields through a `MessageChannel`
  instead — no paint needed, and unlike chained timers it is not throttled to
  1/s in background tabs.
- `PROGRESS_INTERVAL_MS` (250).

**Imports from project modules.** None (safe under the Node test stubs: every
DOM access is null-guarded, and with no `requestAnimationFrame` it yields via
`MessageChannel`).

**Imported by.** `import-export/save-load.js` (re-exports `showLoading`/
`hideLoading`), `pose/tracker.js`, `pose/triangulation.js`, `ui/export-modals.js`,
`loading/session-loader.js` (Load Single Session Folder's three-step progress).

**Notes / caveats.**
- **Why the bar is smooth with only ~4 updates/s:** the fill is scaled with
  `transform: scaleX()` under a 250 ms linear CSS transition (`styles.css`
  `.loading-progress-fill`, matched to `PROGRESS_INTERVAL_MS`). Transform
  transitions run on the compositor thread, so the bar keeps gliding while the
  main thread computes the next chunk — the same reason the spinner keeps
  spinning. Animate `width` instead and it would freeze between updates.
- Cost: each yield waits ~one display frame plus the overlay repaint, so the
  overhead is ≈ frame-time / 250 ms. `tests/e2e/_bench-progress-overlay.mjs`
  measures run time, update cadence and paints/s on a real project.
- Not to be confused with `ui/loading-progress-modal.js`, the per-camera,
  multi-row panel used for video loading.

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
  `updateInfoPanelToggleBtn`, `toggleInfoPanel`,
  `update3DViewportToggleBtn`, `toggle3DViewport`.

**Imported by.** `pose/initialization.js`.

**User-facing features.** Drag-to-resize panel boundaries between video
grid / 3D / info-panel / timeline. Also wires the two toolbar panel-toggle
buttons (`#infoPanelToggleBtn`, `#viewport3dToggleBtn`) and keeps their state
in sync from the `MutationObserver` that watches the 3D container's and info
wrapper's `class` attributes — so a collapse from any entry point (button, `\`,
View menu) updates both buttons, and the initial state is correct.

---

### ui/modal-geometry.js

**Purpose.** Remembered size and position for resizable modals.

A modal that opens at a fixed 880x620 in the middle of the screen is fine until
its content is a table of every node in the skeleton. Then the user wants it
BIGGER, and wants it to stay that way — reopening at the default every time is
the same work over and over. This gives a modal card a drag handle, a resize
grip (CSS `resize: both`, so the grip itself is the browser's) and a
`localStorage` record of where it ended up.

**Key exports.**
- `clampGeometry(geom, viewport, opts)` — the load-bearing one, and pure. A
  remembered rect is restored into a viewport that may be nothing like the one
  it was recorded in (a smaller window; a laptop screen after the external
  monitor is gone), and applying it blindly is how a modal ends up off-screen
  with its header — drag handle AND close button — out of reach. Size clamps to
  `[min, available]` with available winning, position clamps so the whole card
  is inside, and `opts.margin` keeps a gutter at the edges. Returns `null` for
  anything unusable, so the caller falls back to centring instead of applying
  half a rect.
- `centerGeometry(w, h, viewport, opts)` — first-open placement.
- `readGeometry(id, storage)` / `writeGeometry(id, geom, storage)` /
  `clearGeometry(id, storage)` — the `lucid.modalGeometry.v1` record, keyed by
  modal id so one modal cannot clobber another. Reads are **not** clamped:
  clamping on the way in would let one small window permanently shrink the
  remembered size.
- `installModalGeometry(card, opts)` — restores, wires the header drag, watches
  the CSS resize via `ResizeObserver`, re-clamps on window resize, and returns a
  `dispose()` that also flushes the final rect (a resize that ended inside the
  200 ms persist debounce would otherwise be lost when the modal closes).

**This module is the ONE owner of the card's rect.** `.settings-modal`
deliberately has no `max-width`/`max-height`, and `apply()` sets both to `none`
inline: a stylesheet cap alongside the clamp would silently shrink a width the
clamp thought it had granted, landing the card flush against one edge with a gap
on the opposite side.

**Geometry is browser-local display taste**, so it lives in `localStorage` and
NOT in the `.slp` — the same call CLAUDE.md makes for the Visibility panel's
global appearance preferences. Where someone likes their Settings window on THIS
screen says nothing about the project. Blocked or full storage degrades to
"forgets", never to a throw.

**Imports from project modules.** None — `clampGeometry` is a pure function of
(rect, viewport), so it bridges into both test runners.

**Imported by.** `ui/settings-modal.js`.

**Tests.** `tests/test-modal-geometry.js` (the clamp and the record, both
runners) and `tests/e2e/settings-modal-geometry.mjs` (the real modal: resize,
drag, close, reopen).

---

### ui/overlay-export-layout.js

**Purpose.** The pure half of "Export Video Overlays" (issue #190):
composition geometry, output sizing, encoder parameters, the persisted settings
schema, and the seed-layout plan. Deliberately **dependency-free** — no project
imports, no dockview, no DOM beyond `localStorage` — so it can be bridged into
the classic-script unit runner and exercised without a browser dock.

**Key exports.**
- `TILE_3D` — the synthetic view name (`'__3d__'`) of the 3D viewport tile.
- `fitRect(srcW, srcH, dstW, dstH)` — aspect-preserving "contain" fit. **Must
  stay numerically identical to `videoToCanvas()` in `ui/overlays.js`**: the
  video is drawn with this and the skeleton with that, so any divergence offsets
  every burned-in overlay from the animal. Pinned by
  `tests/test-overlay-export-layout.js`, which computes both and compares.
- `distributeAxisSizes(base, min, max, vis, k, d, mode)` + `SASH_SHARE_FAR` /
  `SASH_GROW_ONE` / `SASH_SHARE_SIDES` — sizes for one dock AXIS after dragging the
  sash at index `k` by `d` px, so a resize is shared by more than the one adjacent
  tile. dockview 6.6.1 hands the whole delta to that neighbour and only spills when it
  clamps, and nothing configures that (see the `ui/overlay-export-modal.js` entry).
  **The governing constraint:** a sash sits at the running SUM of the sizes before it,
  so *"the sash stays under the cursor"* is the same statement as *"the total before
  the sash changed by exactly the drag"*. Combined with *"the dragged tile changes
  1:1"* that forces the tiles before the sash to hold still — so wanting all three of
  {sash tracks cursor, dragged tile 1:1, EVERY other tile shares} is **geometrically
  impossible** for any sash but the first. One of them must be given up, which is why
  there are three modes rather than one.
  **`'share-far'` is what the modal uses**: the sash is tile `k`'s trailing edge and
  only the tiles BEYOND it take part — push it out and tile `k` grows by exactly the
  drag while each tile after it gives up an equal share; pull it in and tile `k`
  shrinks by exactly the drag while each tile after it gains. Tiles before the sash
  never move, so the handle tracks the cursor exactly and both "make this one bigger"
  and "make this one smaller" stay expressible. **Accepted gap:** the LAST sash on an
  axis has one tile beyond it, so that single drag is still neighbour-only — pinned by
  a unit test so it reads as a decision, not a regression.
  `'grow-one'` shares with every tile instead (`delta/(n-1)` each). **Shipped once and
  reverted**: the sizes are right, but tiles on both sides move, so the sash trails the
  cursor by an amount that depends on which sash you grabbed — measured in a real dock
  at 80/53/26 px for an 80 px drag on a 4-tile axis's three sashes (100%/66%/33%), and
  it reads as completely broken. `'share-sides'` (tiles before the sash share the gain,
  after share the loss) tracks the cursor but has no shrink-one gesture.
  The result **always sums to `sum(base)`**, so the axis total — and therefore the
  dock's box and every other axis — is untouched; swept over `k`, `d` and all three
  modes by a unit test, because a drifting total would move the exported frame.
  `fillEvenly` does even-share-**with-spill**: a tile pinned at its 100px minimum
  holds still and the tiles with room absorb its share. It deliberately does NOT veto
  the drag — an earlier version did, and a real seeded dock routinely has a tile at
  the minimum, which made the sash feel dead.
- `rotatedBoxSize(srcW, srcH, rotationDeg)` / `rotatedFit(srcW, srcH, dstW, dstH,
  rotationDeg)` — the rotation-aware half of the fit. The main window rotates the
  whole `.canvas-wrapper` (`applyZoom`, loading/video.js), so a 90° camera rotation
  SWAPS a view's effective width and height and anything asking "what aspect is
  this view?" must ask the ROTATED box. Cardinal angles are special-cased so 90/270
  come out **exactly** swapped — trig dust would make an output dimension odd and
  H.264 rejects odd yuv420 dimensions. `rotatedFit` returns the scale plus the
  UNROTATED box size (`boxWidth`/`boxHeight`), which is what a tile draw needs: it
  paints video AND overlays into that box centred on the tile and rotates the box.
  **At rotation 0 `rotatedFit` degenerates to `fitRect` exactly** (same
  `Math.min(dstW/srcW, dstH/srcH)`) — pinned by a test, since that identity is the
  whole no-regression guarantee for unrotated projects.
- `computeTileRects(dock, tiles, outW, outH)` — maps dock-local tile rects into
  the output canvas (the dock is fitted first, so a mismatched output aspect
  letterboxes the whole composition rather than distorting it). Integer pixels,
  clamped into bounds, never degenerate.
- `outputSizeFor(aspect, presetKey)` — height from `RES_PRESETS`, width from the
  aspect, clamped to `MAX_OUT_DIM` (3840) with the height recomputed so the aspect
  holds. **Always even**: `VideoEncoder` rejects odd H.264 (yuv420) dimensions, so
  an odd size is a hard export failure.
  `RES_PRESETS` is the **one quality-tier table both video-export modals use** —
  **480 / 720 / 1080 / 2160**, keys ARE the height, labels state the pixel size
  (`2160p (3840×2160)`). `ui/export-modals.js` builds its `V3D_RES` from it, so
  the two modals cannot offer different choices again. Each entry's `refW` is the
  16:9 reference width: the exact output width for the always-16:9 3D viewport,
  and only a label hint here, where the real width follows the composition aspect.
  Note `2160`'s `refW` (3840) is exactly `MAX_OUT_DIM` — one pixel more and every
  16:9 4K export would silently clamp and lose height (pinned by a test).
  `sanitizeSettings` maps a retired key (`360`, then `1440`/`2K`) to `DEFAULT_RES`
  rather than to the nearest surviving tier, so reopening the modal cannot
  silently ~2.25× the pixels, bitrate and file size of the next export.
- `outputSizeFrom(settings, aspect)` / `RES_CUSTOM` / `clampOutDim(n)` /
  `customAspect(settings)` — the editable-dimensions path. `res: 'custom'` uses
  `settings.outW` × `settings.outH` verbatim instead of deriving the width from
  the composition; `clampOutDim` puts a hand-typed value through the same
  even/2..`MAX_OUT_DIM` gate the presets satisfy by construction.
  `customAspect` returns the aspect the modal must **shape the dock to** (null
  for a preset, where dock and output agree already) — shaping it is what stops
  `computeTileRects` from burning letterbox bars into a custom-size export.
- `bitrateIsClamped(W, H, fps, quality)` — true when `bitrateFor`'s [1, 48] Mbps
  band actually bit. The clamp makes adjacent Quality tiers **collide**: at
  3840×2160@60 `medium` and `high` are BOTH 48 Mbps, and at 640×360@30 `low` and
  `medium` are BOTH 1 Mbps. There, changing Quality changes neither the estimate
  nor the encoded file — and with nothing saying so, a correctly-wired picker just
  looks broken, which is why the modal's output note surfaces it.
- `h264CodecFor(W, H)`, `bitrateFor(W, H, fps, quality)`, `QUALITY_BPP`. **Both
  video-export modals call these** — `showExport3DVideoModal`'s `_v3dBitrate` is
  now just `bitrateFor(W, H, fps, 'medium')`. Its own copy clamped to
  [2, 24] Mbps against this module's [1, 48] Mbps, so it doubled the bitrate (and
  its own size estimate) at the smallest tier and would have capped the 2160p tier
  at 24 Mbps instead of the 29.9 Mbps the formula asks for.
- `estimatedBytes(W, H, fps, quality, nFrames)` — expected size of one output
  file. Both modals' summary lines AND both streaming decisions read this, so
  the size the UI promises cannot drift from the size the export plans for.
  Returns 0 for a degenerate fps/range rather than `NaN`/`Infinity`.
- `shouldStreamToDisk(totalBytes)` / `STREAM_TO_DISK_BYTES` (256 MB) — the
  buffer-vs-stream split. Under the threshold an export buffers and downloads
  exactly as it always has (no destination prompt); over it, the export asks for
  a real file/folder and streams into it, because that much output buffered in
  the pointer-compressed heap is the failure mode CLAUDE.md documents for
  luc3d #185/#190/#191/#193. Used by BOTH video modals.
- `defaultOverlayExportSettings()`, `mergeSettings(base, saved)`,
  `sanitizeSettings(s)`, `applyStoredSettings`, `saveOverlayExportSettings`,
  `SETTINGS_KEY` (`'overlayExportSettings.v1'`), `DEFAULT_RES` (`'1080'`).
  `mergeSettings` is schema-driven: it ignores
  keys `base` doesn't declare and values whose `typeof` doesn't match, so a stale
  or hand-edited blob can never introduce an unknown key or slip a string into a
  canvas/encoder parameter. It only type-checks, though, so `applyStoredSettings`
  follows it with `sanitizeSettings`, which holds `res` to the *current* preset
  set — the list has already changed once (`360` → `480`), and a stored key
  nothing recognises would blank the `<select>` while `outputSizeFor` quietly fell
  back to `DEFAULT_RES`, leaving the summary quoting a size the visible control
  doesn't name. `sanitizeSettings` also **folds a stored `labelSize` of 0 into
  `showLabels: false` and restores the default size** (issue #223): a blob written
  before the toggle existed encodes "off" as a 0 and carries no `showLabels`, so
  without this the setting would come back ON *and* the toggle would be dead,
  since 0px labels draw nothing. A 0 is unreachable from the current modal, so
  this can only ever be reading the old meaning.
  `UNRESTORED_KEYS` (`res`, `outW`, `outH`) are **written to storage but never read
  back**, so the modal always opens at `DEFAULT_RES` = **1080p**. The tier decides
  pixel count, bitrate and therefore file size, and a value silently inherited from a
  previous session is the kind of thing you only notice after sitting through a 4K
  encode — so a departure from 1080 is always a choice made in front of the current
  export's summary line. `outW`/`outH` come along because they are only consulted when
  `res === RES_CUSTOM`, and a stale custom size behind a reset tier would let one click
  on "Custom" resurrect dimensions from another day. Everything else — layers,
  per-type styling, fps, quality, mode — IS still restored: those are how the user
  likes overlays to look, not how big the file will be. Note it is the **read** that
  resets, not the write; `tests/e2e/overlay-export-modal.mjs` asserts both halves.
- `overlayOptionsFrom(settings, videoW, videoH, canvasW, canvasH)` — the
  settings → `drawFrameOverlays()` options translation. Explicitly nulls ALL
  interaction state (selection / hover / drag / assignment): an export has no
  cursor, and a stray highlight would be burned into the video.
  **Node labels are gated by `showLabels`, never by their size** (issue #223).
  `settings.user.showLabels` / `settings.reproj.showLabels` are real booleans the
  modal surfaces as `Show node labels`, beside `Show nodes` / `Show edges`;
  `labelSize` is only a size, floored at 1 in the modal. Before #223 the only off
  switch was a size of 0, which is undiscoverable and reads as "make it tiny".
  Defaults are user **on** / reproj **off**, matching the Visibility panel's own
  (`visUserLabelSize` 12, `visReprojLabelSize` 0), so a fresh export renders what
  the app is already showing. **Predicted has no toggle because the app has no
  such layer**: `ui/rendering.js` hardcodes `predictedOpts.showLabels: false`
  too, so predicted instances have never carried node names and an export toggle
  would be inventing one. Note `showLabels` also gates the TRACK-name labels
  (`drawInstanceLabels`), exactly as the size-of-0 gate did — one meaning of
  "labels", shared with the live app, rather than a split only the export knows
  about.
- `seedLayoutPlan(viewNames, include3D)` — the mirror-the-main-window seed (same
  row-count heuristic as `addAllViewsAsGrid`, 3D docked right of the whole grid).
  Returns add-panel steps whose positions reference **earlier** entries by index,
  so the caller can substitute real dockview panel ids as it walks forward.

**Imports from project modules.** None (by design).

**Imported by.** `ui/overlay-export-modal.js`; `ui/export-modals.js`
(`shouldStreamToDisk`, so both video exports share one threshold); bridged into
`tests/test-runner.html` as `window.__OverlayExportLayout`.

---

### ui/overlay-export-modal.js

**Purpose.** The "Export Video Overlays" modal (File menu, above "Export 3D
Video") — issue #190. Renders the session's 2D camera videos **with pose
overlays burned in**, plus the 3D viewport, either stitched into one composed
video laid out exactly as the user arranged it, or as one file per tile. The
counterpart of SLEAP's `View ▸ Render Video Clip with Instances…`
(`sleap/gui/dialogs/render_clip.py`), extended with LUCID's multi-view
composition and its user / predicted / reprojected overlay layers.

**Key exports.** `showOverlayExportModal()`, `settingsFromVisibilityPanel()`,
`loadOverlayExportSettings()`, and a re-export of `TILE_3D`.

**Layout.** `[views strip] [composition dock] [settings panel]`. The strip lists
the **3D grid FIRST**, then one thumbnail per video; drag or double-click to dock.
An entry that IS docked is **highlighted** — accent border + `--accent-dim` wash +
a dot, matching `.session-strip-item.active` (`styles.css:360`) — by
`refreshStripHighlights()`. That used to be inverted: a docked entry was faded to
`opacity: 0.55`, which reads as *disabled*, the opposite of selected. It runs from
exactly three sites, which is exhaustive because they are the only three that
mutate the `tiles` map behind `isDocked`: `buildStrip()`, `TilePane.init` (the sole
choke point for every add — dockview always calls `init` from `addPanel`, even for
an inactive stacked tab) and `onDidRemovePanel` (tab X, whole-group close,
close-everything). A panel MOVE deliberately gets no hook: dockview wraps moves in
`movingLock` so neither event fires, and a moved panel keeps its id, so the docked
SET is unchanged by definition.
**Strip order is independent of DOCK order**: the 3D tile is still SEEDED last, a
column to the right of the whole video grid (`seedLayoutPlan`). Reordering the
strip must not move the tile, or every existing user's exported frame layout would
shift; `tests/e2e/overlay-export-modal.mjs` asserts the tile's geometry stays right
of the cameras, and `tests/test-overlay-export-layout.js`'s "3D docked last" pins
the plan.
**`qualityPhrase(W, H, fps, approx)`** builds the Quality half of the output note —
tier name, the Mbps it really encodes at, and a "capped" warning from
`bitrateIsClamped`. Bitrate is the one output setting a still preview CANNOT show
(it exists only after H.264 encoding), so this text is the whole of the live
feedback for the Quality picker; naming the tier in only the stitched branch is
what made a correctly-wired picker read as inert in individual mode.
The middle is its **own `DockviewComponent` instance** (same pinned
`dockview-core@6.6.1` as `ui/sessions-panes.js` — **three** pins now share that
version: `index.html`'s CSS, `sessions-panes.js`, and this module), seeded via
`seedLayoutPlan` to mirror the main window. The settings panel carries the frame
range (**1-based display**, 0-based internally, matching the issue) at the top,
then layers, per-layer appearance, background, and quality/output.
**`Show node labels`** (issue #223) sits in the User and Reprojection Appearance
groups with `Show nodes` / `Show edges`, and the `Node label size` field below it
floors at **1** — an off switch hidden at the bottom of a numeric range is
precisely what the toggle replaces. The Reprojection group gained its own
`Node label size` / `Label opacity` fields at the same time, so the toggle it
grew is not the only reprojection-label control. `settingsFromVisibilityPanel`
SPLITS the panel's folded encoding on the way in: the panel says "off" with a
size of 0, so a 0 seeds `showLabels: false` and leaves the export's size at its
default — copying the 0 through would leave the toggle able to turn on nothing.
There is no Predicted entry; see `overlayOptionsFrom` above for why.

**Output dimensions.** Quality & Output has a Resolution picker — the four shared
tiers **480p (854×480) / 720p (1280×720) / 1080p (1920×1080) / 2160p (3840×2160)**
from `RES_PRESETS`, plus **Custom** — and a live `width × height` row. Quality
itself is a *separate* control here: it is the bitrate tier (low / medium / high
via `QUALITY_BPP`), not a resolution, which is why this modal keeps both where
`showExport3DVideoModal` labels its single tier picker `Quality`. `resTierLabel()`
names the chosen tier in the summary line next to the literal `W×H`, because the
two can legitimately disagree — a preset fixes only the HEIGHT, so a very wide
composition clamps the derived width to `MAX_OUT_DIM` and recomputes the height,
and "2160p" can encode at 3840×960 (reported as `2160p (width-capped)`). The
fields always show the size the
export will really be — for a preset that is the derived size, refreshed by
`syncOutFields()` out of `refreshSummary()` as the composition changes — and
typing in either one is itself the gesture that switches Resolution to Custom, so
the previously-shown derived numbers become the starting point. A custom size
re-shapes the **dock** to that aspect (`applyDockAspect`, re-run on settings
change and by a `ResizeObserver` on `#ovDockFrame`), which keeps the composition
WYSIWYG: dock aspect and output aspect agree again, so `computeTileRects` fills
the frame instead of letterboxing it. In individual mode a custom size applies to
every file, with each tile letterboxed into it.

**Reprojection fill.** `ensureReprojections()` is the export-side mirror of
`ui/rendering.js`'s lazy fill, so exporting a triangulated-but-never-viewed range
still draws reprojections. It **resolves the method from the group**
(`triangulationMethod === 'ba' ? 'ba' : 'dlt'`) exactly as the display path does:
omitting the option silently re-solves with DLT, which would burn DLT
reprojections into the video while the app shows BA's, breaking the
"exported 3D == displayed 3D" invariant. Guarded by
`tests/test-triangulation-method-propagation.mjs`, which scans every
`triangulateAndReproject` call site in the repo.

**Still-frame previewer, no playback.** The modal has **no transport**: no
play/pause, no frame stepping, no `setPlaying`/`playTimer`. Scrubbing the track is
the only way to change frames (the range fields also preview the boundary they
commit). Playing a multi-view composition here decoded every docked view per tick
*and* pushed every tick into the app viewer, competing with the export the modal
exists to configure; a single rendered frame is what tells you whether the
overlays look right. Note the consequence: exact single-frame navigation now costs
a pixel-accurate scrub, which is coarse on a long video — the range fields are the
precise way to land on a specific frame.

**Preview ↔ app viewer.** Scrubbing in the modal drives the real viewer through
`videoController.scrubToFrame()` (`syncViewer`, called from `showFrame`), so the
app's canvases, overlays and timeline follow the modal playhead and closing the
modal leaves you on the frame you stopped at. `scrubToFrame` is the **coalescing**
entry point — it keeps one seek in flight and drops intermediate targets — so a
fast drag doesn't queue a decode backlog behind the preview. Suppressed while
exporting.

**Track gestures.** The two gestures on the scrub track are separated by *what you
press*, tracked by `dragging` (`'playhead' | 'start' | 'end'`). Pressing the track
scrubs the **current frame** and drags it; a range endpoint moves only when its
handle is grabbed directly (the handles sit above the track via `z-index` and
claim their own `pointerdown`, so such a press never reaches the track handler).
Pressing the track used to pull whichever endpoint was *nearer*, which meant an
innocent click halfway along silently redefined what would be exported — and which
end moved depended on invisible arithmetic. Scrubbing is deliberately **not**
clamped to the export range, so you can look just outside it before committing —
the playhead is a preview cursor, not an export bound. Releasing an endpoint
previews the boundary it was dropped on; releasing a playhead drag leaves the
frame where it is.

**Rendering model.** Every tile owns **two** canvases (video + overlay), exactly
like the main window's `.canvas-wrapper`, because `drawFrameOverlays()` opens
with a full-canvas `clearRect` and would otherwise erase the video drawn beneath
it. Preview canvases track the tile's CSS box; export allocates **separate**
canvases at the tile's output pixel box, so preparing an export never disturbs
the live preview. Composition geometry is read straight off the DOM
(`captureLayout` → `computeTileRects`), which is what makes the stitched output
WYSIWYG with the dock the user arranged. A tile whose rect is <2px (a hidden tab
in a stacked group) is skipped. `addTile` splits right rather than stacking when
given no position — a stacked tab is hidden, so "add to composition" would
otherwise silently do nothing visible.

**3D tile.** A second `Viewport3D` (`preserveDrawingBuffer: true`), as in
`showExport3DVideoModal`. For export its renderer is `setSize(w, h, false)`'d to
the output tile box (CSS size untouched) with the container `ResizeObserver`
**disconnected**, then restored afterwards.

**Encoding.** Delegated entirely to **`ui/video-encode.js`** (mediabunny), shared
with the 3D video export — this module no longer touches `VideoEncoder` or a
muxer. Individual mode runs N writers inside the SAME frame loop, so each frame
is decoded once no matter how many files come out, and `await writer.addFrame()`
is what applies backpressure. **Destination:** an export whose estimated total
exceeds `shouldStreamToDisk` asks for a save-file (stitched) or a folder
(individual, one `getFileHandle` per tile; the folder handle is deliberately NOT
cached to `state.exportDirHandle`, which `showSlpExportAllModal` reuses without
prompting) and streams into it; below the threshold it buffers and
downloads exactly as before, so a short export is still one click. Declining the
picker for a large export **cancels** it rather than silently falling back to the
memory buffer that was being avoided; with no File System Access API at all the
user gets the same `confirm()` warning `exportLabels()` uses. Cancelling a
streamed export leaves a real partial `.mp4` on disk (mediabunny closes the
writable), which the status message says outright.

**Settings persistence.** Seeded from the live Visibility panel
(`getVisibilitySettings()`) on first open so an export defaults to looking like
the app, then persisted to `localStorage` — surviving session switches within a
project and page reloads. The **layout** is deliberately NOT persisted; a
reopened modal re-seeds from the main-window mirror.

**Sash drags are taken over from dockview.** A capture-phase `pointerdown` on
`#ovDock` intercepts sash drags and re-implements them via `distributeAxisSizes`, so
the change is shared across the whole axis instead of dumped on one neighbour.
dockview 6.6.1 offers no option for this: `proportionalLayout` governs CONTAINER
resize, is hardcoded `true`, is not in `DockviewComponentOptions`, and
`updateOptions` says "not supported" outright; `distributeViewSizes()` equalises
every view (throwing the composition away) and is on no public API; `LayoutPriority`
only reorders the same spill list and the sash handler passes `undefined` for both
priority lists, so it cannot reach a drag at all. Post-correcting in
`onDidLayoutChange` was rejected — that fires **once at drag end**, so the drag would
look native and then jump on release. Capture-phase `stopPropagation()` on an
ancestor prevents dockview's own listener (bound to the sash **element**) from ever
running, so there is exactly one handler and nothing to fight. An axis of two tiles
with nothing to keep aligned is left to dockview on purpose — there our arithmetic and
dockview's agree exactly.

**A row divider moves that boundary in EVERY column** (`axesForSash`). dockview nests a
4+ camera grid **column-major**: the root axis's children are columns, and each column
owns its own vertical axis of rows. So a row sash natively resizes only its own column,
and the grid drifts ragged with no gesture anywhere able to straighten it (measured:
dragging column 1's row divider left `c1` at 417 px and `c4` at 257 while the other
columns stayed at 337). `axesForSash` therefore returns the dragged axis **plus every
sibling axis that has a boundary at the same index `k`**, and the drag is applied to all
of them with the same delta. A sibling with too few tiles to have boundary `k` — a
camera spanning the full height, or the 3D tile — simply does not take part, which is
what leaves full-height tiles alone instead of splitting them. The ROOT axis has no
parent, hence no siblings, so a COLUMN drag still just resizes columns (both videos in
a column together), and a row drag never changes a width.
This reaches **TypeScript-private dockview internals** — `gridview.root`, node
`children` / `element` (walked to find the branch owning the sash **and its parent**),
`BranchNode.splitview`, `Splitview.viewItems` / `sashes` / `layoutViews()` /
`distributeEmptySpace()` / `saveProportions()`, and `viewItem.enabled` — all verified
to resolve at **runtime** against the live minified `/+esm` build, not just by grep.
Every one is feature-detected: if any is missing the handler returns WITHOUT calling
`stopPropagation()` and dockview's stock neighbour-only drag runs, so a version bump
can regress the behaviour but cannot break resizing.
Two e2e files cover this, and the split matters:
`tests/e2e/overlay-export-sash-distribute.mjs` covers the sharing on a FLAT axis
(confirmed to FAIL on the pre-fix code, delta `-60, 0, 0`) and drags twice to assert the
first drag's asymmetry survives — the guard against an "equalise everything" fix making
the dock un-resizable. But it only ever drags **sash 0**, where share-far and grow-one
are the same arithmetic, and it asserts its axis is flat — so it is structurally blind
to both cursor tracking and the grid. `tests/e2e/overlay-export-sash-tracking.mjs`
covers exactly those: the handle tracking every sash (confirmed to fail on `grow-one`,
naming the measured 53 px and 26 px) and the cross-column row boundary on a real 5-camera
nested grid (confirmed to fail with the propagation disabled). **Run both.**

**The tab band is overlaid on the tile, not stacked above it** (`styles.css`,
`#ovDock`). dockview lays a group out as `[tabs][content]` in a column flexbox, so a
35px band cost 35px of video **per grid row** — ~8% of a two-row dock spent on
chrome, with the tiles letterboxed to pay for it. Shortening the band to 20px and
pulling `.dv-content-container` back up by exactly that height gives the tile (and
its canvas backing store) the group's full height; measured 639 -> 674 px, and tile
area 91.7% -> 99.45% on a six-tile composition. The real dockview tab is KEPT, not
hidden: `.dv-tab` is dockview's **drag source**, so `header.hidden` would remove the
only way to rearrange tiles — and `captureLayout()` reads that arrangement off the
DOM, where it IS the exported frame. `position: relative` + `z-index: 2` on the band
is load-bearing: the tile's canvases are absolutely positioned and would otherwise
paint over it and swallow every tab click. Scoped to `#ovDock` because
`.dockview-theme-abyss` is shared with the main window's dock, and declared on
`.dv-groupview` rather than `#ovDock` because dockview puts the theme class on its own
`.dv-shell` **inside** the container, which would otherwise re-declare the height.

**The tab shows the ✕, never the name.** `Render Video Names` burns the caption into
the same top-left band the chip occupies, so a visible tab title drew the name twice a
few pixels apart in a different font — a ghost, worse the longer the name. So
`.dv-default-tab-content` is `width: 0` unconditionally: with the layer ON the name
comes from the burned-in caption (the copy that actually reaches the `.mp4`), and with
it OFF from **hover**. `order: 2` puts the zero-width title AFTER the ✕ so the hover
reveal grows the chip rightward and the ✕ never moves — a control that jumps out from
under the cursor is a bug, and the e2e pins the ✕'s x in all four (layer × hover)
states. A 12px `padding-left` leaves 19px of bare `.dv-tab` — the drag source — to the
left of the ✕, so tiles can still be picked up; `min-width: 44px` is a non-binding
floor in case a dockview bump drops the tab's own padding.
`applyTabNameMode()` toggles `#ovDock.ov-hover-tab-names` from `onChange` AND from
`buildSettings` (Reset replaces `settings` and calls the latter, not the former).
The hover reveal is keyed on **`.dv-groupview:hover`, NOT the tile element**: the tab
band is a *sibling* of `.dv-content-container`, so `[data-view-name]:hover` goes false
the moment the pointer reaches the ✕ and the label would flicker off exactly as the
user goes to click it (measured, not assumed). It survives the
`.dv-content-container { pointer-events: none }` bypass because that only stops the
container being a hit *target* — `:hover` still applies to ancestors of whatever is hit.
With the layer ON the whole band is `translateY`'d one band-height so the ✕ sits
**below** the caption rather than on it: the caption's width follows the name while the
✕ is pinned at 19px, so a fixed padding cannot clear it ("topL" had its L behind the
glyph). `transform` specifically — it does not affect layout, so the tile keeps the full
height the overlaid band bought. The 3D tile keeps its name in every state (no overlay
canvas ⇒ never captioned), via a `:has()` rule kept SEPARATE so an engine without
`:has()` cannot drop the hover reveal along with it.

**Display settings are inherited from the main window, not re-exposed.** Every 2D
tile is rendered with that camera's **brightness, contrast, rotation and zoom** as
the main window has them, by one shared `drawTileContent(vctx, octx, …)` that both
the preview (`paintTile`) and the export (`drawExportTile`) call — they used to be
two near-identical bodies labelled "export-time twin", i.e. two things guaranteed
to drift. The modal deliberately has **no** control for any of the four (only the
unrelated `settings.reproj.brightness`, an overlay *marker* dimming factor), and
says so in `#ovDisplayNote`.

This is not free: the main window applies all four as **CSS on live elements** —
`view.canvas.style.filter` for brightness/contrast (`applyVideoFilters`), a
`.canvas-wrapper` transform for rotation and zoom (`applyZoom`) — and **none of it
survives a `drawImage` of the decoded frame into another canvas**, the same reason
`applyVideoFilters` must re-set the filter on duplicate panes' mirror canvases. So
the tile re-applies them: brightness/contrast via **`ctx.filter`**, which takes
exactly the CSS filter-function list `buildVideoFilter` already emits (so the modal
and the live canvas cannot disagree); rotation and zoom via a context transform
applied to **video and overlays together**, because the main window transforms one
wrapper holding both canvases — transforming only the pixels would slide every
skeleton off the animal. Three details are load-bearing:
- the overlay canvas is cleared under the **identity** transform first, because
  `drawFrameOverlays`'s own `clearRect(0,0,w,h)` clears a *rotated* rect once a
  transform is set, leaving the previous frame's skeleton in the corners of the
  reused export canvas;
- the legend is drawn **outside** the transform — `drawLegend` anchors to
  `ctx.canvas.width` rather than the size it is passed, so inside the transform it
  drifts by the letterbox offset (a regression even at rotation 0) and lands upside
  down at 180°;
- `ctx.filter` is reset with `'none'`, never `''` — an empty string is an invalid
  value the setter silently ignores, which would leak the video's brightness onto
  the overlay composite. `buildVideoFilter` returns `''` when both are default.
Rotation prefers `view.rotation` over the session value: the hold-to-rotate chord
advances the view every frame and only commits on keyup, so mid-gesture the view is
what the user is actually looking at; a view never docked in the main window has no
`view.rotation`, hence the session fallback. `individualSizeFor` derives each
per-tile file's aspect from the **rotated** box, so a 90°-rotated 640×480 view
exports portrait (360×480 at the 480 tier) instead of a landscape file with the
frame pillarboxed inside it.
**Zoom fidelity is partial, by construction:** magnification and pan centre match
the main window, the visible **crop cannot**. The main window's crop comes from
`.video-cell`'s `overflow:hidden` at the *cell's* aspect; an export tile has its own
aspect, so a wider tile simply shows more video, and at high zoom near a frame edge
that means black past the edge. The transform mirrors `applyZoom`'s CSS list under
`transform-origin: 0 0`, which is why there is a `(z-1)*box/2` term (CSS scales
about the TOP-LEFT, not the centre) and why the pan is converted from main-window
CSS px by `box/baseW`. Covered end to end by
`tests/e2e/overlay-export-display-settings.mjs`, which needs its own file because
the main modal e2e runs decoder-less — black pixels are invariant under
brightness/contrast and symmetric under rotation, so that suite cannot detect
whether any of this is applied.

**Unlinked instances ARE drawn**, in the preview and in the encoded frames, by
`collectUnlinked(frameGroup, viewName)` — which reads the RAW `FrameGroup` via
`getUnlinkedInstances()` (NOT the `toOverlayFrameGroup` copy, which carries only
`frameGroup.instances`) and filters by the User/Predictions layer checkboxes, so
unticking a layer drops its unlinked instances too. It is assigned onto the
options as `opts.unlinkedInstances = …` rather than passed in the
`overlayOptionsFrom` literal — worth knowing, because a grep for
`unlinkedInstances:` misses it and makes the export look like it drops them.
`overlayOptionsFrom` pins **`showUnlinkedBadge: false`**, so the skeleton is
exported but the amber `?` editing prompt is not.

**Imports from project modules.**
- `./app-state.js` — `state`, `videoController`, `getActiveSession`.
- `./browser-hints.js` — `fileSystemAccessHint` (appended to the in-memory
  export confirm in Brave).
- `./viewport3d.js` — `Viewport3D`.
- `./overlays.js` — `drawFrameOverlays`, `getTrackColor`, `getGroupColor`.
- `./rendering.js` — `getVisibilitySettings` (the seed).
- `./overlay-export-layout.js` — the pure helpers above.
- `./video-encode.js` — `createMp4Writer`, `videoEncodingAvailable`.
- `./video-filters.js` — `buildVideoFilter`, `getSessionBrightness`,
  `getSessionContrast`, `getSessionRotation`. That module imports no project
  modules, so this adds no cycle, and sharing `buildVideoFilter` with
  `applyVideoFilters` is what keeps the export from drifting from the live view.
- `../pose/triangulation.js` — `getInstanceGroupsForFrame`,
  `ensureLazyFrameData`, `ensureLazyTrailWindow` (the frames behind the first
  exported frame and the preview frame that the node trails draw),
  `triangulateAndReproject`, `storeReprojectedInstances`,
  `sessionHasCalibration`.
- `../pose/pose-data.js` — `points3dNodeCount`.
- `../import-export/save-load.js` — `setStatus`.

**Imported by.** `ui/ui-wiring.js` (`menuExportOverlayVideo`).

**Tests.** `tests/test-overlay-export-layout.js` (geometry / encoder params /
custom-size clamping / preset set / stale-`res` fallback / settings merge /
seed plan) and
`tests/e2e/overlay-export-modal.mjs` (menu placement, dock seeding, 1-based range
validation, settings round-trip, absence of any playback transport,
scrub-to-app-viewer sync, live dock
re-shaping on a custom size, and a **real** end-to-end mp4 export in all three
shapes — stitched, individual, and custom-size. The `avc1` sample entry's
width/height is asserted against `outputSizeFor`/the typed dimensions, which is
what proves the layout capture and the encoder config agree).

The **track-gesture** split is driven with real mouse events rather than synthetic
dispatch, because the behavior is entirely about which element a press hit-tests
to. Note which assertions actually discriminate it: the ones checking the export
range is *unchanged* by a track press. A scrub lands on the same frame under
either implementation — the old nearest-endpoint code previewed the endpoint it
had just dragged — so the playhead assertions alone would pass on the old code
too. Both range assertions were confirmed to fail against it.

---

### ui/video-encode.js

**Purpose.** The app's **only** video-encoding seam. Both video exports
("Export Video Overlays", "Export 3D Video") go through it; neither constructs a
`VideoEncoder` or a muxer any more.

**Why it is not sleap-io.js.** sleap-io.js has **no browser video encoder** —
verified across every ref, not just the vendored pin. Its only encoder,
`renderVideo()` (`src/rendering/video.ts`), spawns a native `ffmpeg` and is
exported solely from the Node entry, never from `src/index.browser.ts`; its own
docs state "there is no encoder in the JS port". So this is the one part of the
video pipeline LUCID must own — and it owns it thinly, on top of **mediabunny**,
the library sleap-io.js itself uses for decode and which LUCID already vendors in
full (`lib/mediabunny/`, importmap `mediabunny`). This replaced the vendored
**mp4-muxer 5.2.1 (deleted)** and the duplicated hand-rolled WebCodecs pairing.

**Key exports.**
- `createMp4Writer({canvas, width, height, fps, bitrate, frameCount,
  fullCodecString, keyFrameEveryFrames, fileHandle})` → `{addFrame(outIdx),
  finish(), cancel(), streaming, codec, fastStart, framesAdded}`. The writer is
  bound to ONE canvas, sampled at each `addFrame`.
- `resolveH264Config(width, height, bitrate, preferredCodecString)` — probes with
  `canEncodeVideo` and degrades to mediabunny's own level pick if the caller's
  exact H.264 level string isn't encodable here. Returns `null` when H.264 is
  unavailable at that size, which is what turns into the user-facing error.
- `videoEncodingAvailable()`, `MP4_MIME`, `KEYFRAME_INTERVAL_FRAMES` (60).

**What it buys over the old path.**
- **Streaming.** Given a `fileHandle` it writes through a mediabunny
  `StreamTarget` at bounded memory instead of buffering the whole `.mp4` in an
  `ArrayBufferTarget` — the failure mode CLAUDE.md documents at length for
  luc3d #185/#190/#191/#193 (V8's pointer-compressed cage, hard-capped near 4 GB
  in a Chrome renderer).
- **moov-at-front while streaming.** Callers know the frame count, so it passes
  `fastStart: 'reserve'` (+ `maximumPacketCount` in the track metadata, which
  that mode requires) to reserve the sample table, stream `mdat`, then seek back
  and write `moov` ahead of it. **mediabunny defaults `fastStart` to `'in-memory'`
  for a BufferTarget but to `false` (trailing moov) for a StreamTarget**, so it is
  always passed explicitly; `tests/e2e/video-encode-streaming.mjs` asserts the
  byte order so a regression to a non-seekable file can't pass silently.
- **Real backpressure that can fail.** `await source.add(...)` settles when the
  encoder has room and **rejects** when it died, replacing a
  `while (encodeQueueSize > 12) await setTimeout(0)` spin that had no exit on a
  dead encoder (the old `error:` callback only logged).

**Contracts it depends on** (none compile-checked — re-verify on any mediabunny
bump, see `lib/mediabunny/PROVENANCE.txt`): `keyFrameInterval` is in **seconds**,
so the historical "keyframe every 60 frames" is `60/fps`, belt-and-braced with a
per-frame `{keyFrame}` flag that mediabunny ORs with the interval; `finalize()`
and `cancel()` both **close the target's WritableStream themselves**, so a
cancelled streamed export commits a partial file.

**Deliberately unchanged from the old encoder.** H.264 only, the callers' own
bitrate maths, and the 60-frame keyframe cadence. VP9/AV1 fallback is a one-line
change here but is a separate decision.

**Imports from project modules.** None. Imports `mediabunny` (importmap).

**Imported by.** `ui/overlay-export-modal.js`, `ui/export-modals.js`.

**Tests.** `tests/e2e/video-encode-streaming.mjs` drives it directly with a
stand-in file handle — necessary because headless Chromium rejects
`showSaveFilePicker()` instantly with `AbortError`, so the streaming path is
unreachable through either modal under automation. It pins position-based writes,
moov-before-mdat on both paths, the frameCount overrun guard, the canvas/size
mismatch guard, and the encoded dimensions. The modals' own end-to-end exports
(`tests/e2e/overlay-export-modal.mjs`, `tests/e2e/export-3d-video.mjs`) cover the
buffered path.

---

### ui/overlays.js

**Purpose.** Pure canvas-rendering helpers for skeleton overlays, color
palettes, and per-frame draw routines. Receives `frameGroup` and
`instanceGroups` already resolved by the caller — no project imports.

**Key exports.**
- Node markers: `drawNodeShape(ctx, x, y, shape, size, color)` — draws one
  keypoint marker in one of six styles (`'circle'`, `'x'`, `'triangle'`,
  `'square'`, plus `'diamond'` and `'cross'` — the plus-sign form, added for
  SLEAP parity in the overlay-video export, issue #190). All 2D node draws route
  through it: `drawSkeleton`
  (normal + nulled nodes, via `options.nodeShape`), `drawReprojectedSkeleton`
  (via `options.nodeShape`, default `'x'`; its edges honor `options.lineStyle`
  via `getLineDashPattern`, falling back to the historical `[4, 4]` dash only
  when no style is passed — it used to hard-code that dash, so the raw-
  reprojection fallback ignored the Visibility panel's Edge Style), and
  `drawUnlinkedInstances`
  (`instNodeShape`). `drawFrameOverlays` threads the per-type Node Style toggle
  through as `nodeShape: {user,predicted,reproj}Opts.nodeStyle`.
- Independent node/edge visibility: `drawSkeleton` and
  `drawReprojectedSkeleton` accept `options.showNodes` / `options.showEdges`,
  both **defaulting to `true`** so every pre-existing caller is unchanged. Only
  the overlay-video export sets them (SLEAP's "Show: ☑ Nodes ☑ Edges"); the live
  Visibility panel has no such toggle. They ride in on the per-type opts bags, so
  `drawFrameOverlays` forwards them without needing to know about them.
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
  `computeLabelOffset`, `getLineDashPattern`, `resolveLabelDisplayScale`,
  `uprightLabelRadians`.
- **`drawLegend` is now an EXPORT-only path.** The live app no longer paints a
  legend onto the overlay canvas — `ui/rendering.js` passes `showLegend: false`
  and the key is DOM chrome in the pane instead (`ui/view-legend.js`), because
  anything on this canvas rotates with the view and is anchored to the video box
  rather than the pane. `drawFrameOverlays` keeps the `showLegend` option, and
  `drawLegend` itself is unchanged, for the overlay-video export, which must
  burn the legend into encoded frames where there is no DOM.
- **Labels stay upright when the view is rotated** (issue #162).
  `options.labelRotation` (DEGREES, threaded through `drawFrameOverlays`'s
  `geoOpts` from `ui/rendering.js`) reaches `drawSkeleton`,
  `drawInstanceLabels` and `drawUnlinkedInstances`, and drives two things:
  - `uprightLabelRadians(options)` -> the module-private `beginUprightFrame`,
    which pushes a SCREEN-aligned canvas frame around the anchor so the glyphs
    cancel the view's rotation. A view is rotated by a CSS transform on the
    whole `.canvas-wrapper` (`applyZoom`), which the overlay canvas's own
    drawing transform knows nothing about, so every glyph rotated with the
    video — past ~45 degrees unreadable, at 180 upside down. The video and the
    skeleton must STAY rotated (the skeleton is pinned to the animal), so
    cancelling per label is the only option. Covers node names, the
    track/identity pill (`drawNamePill` — plate AND text, or the text would
    hang outside its own backing) and the unlinked "?" badge.
  - `computeLabelOffset`'s new 7th argument, which carries the largest-gap
    bisector into SCREEN space before the SLEAP shift factors size the label
    box against it. Without it each label would keep pointing at the gap it had
    at rotation 0 — i.e. into the skeleton at most angles.
  `beginUprightFrame` touches the transform ONLY when there is a rotation to
  cancel (call sites pair it with `uprightOriginX`/`uprightOriginY` for the two
  coordinate bases), so an unrotated view — every export path, and the common
  case in the app — draws through exactly the coordinates and canvas state it
  did before. Covered by `tests/test-labels.js` ("Labels - stay upright when
  the view is rotated", whose two halves are pinned independently) and end to
  end by `tests/e2e/label-upright-on-rotation.mjs`.
- **Label sizing is screen-relative, and rotation-independent.**
  `resolveLabelDisplayScale(ctx, canvasWidth, options)` answers "backing-store
  pixels per on-screen CSS pixel", and `drawSkeleton` /
  `drawInstanceLabels` / `drawUnlinkedInstances` each multiply their
  `options.labelSize` by it. Node markers and edges are deliberately NOT scaled
  this way — they are video-relative so they stay pinned to the animal — but a
  name is chrome and has to hold a fixed point size at any zoom.
  It prefers `options.labelDisplayScale`, which `drawFrameOverlays` threads
  through `geoOpts` to all three and `ui/rendering.js` computes from the
  canvas's LAYOUT width times the zoom scale. The fallback, for callers with no
  view geometry (the export modals), is the old
  `canvasWidth / getBoundingClientRect().width`, which is correct only while the
  canvas carries no rotation: a rect is the AXIS-ALIGNED BOUNDING BOX of the
  transformed element, so a rotated view reports a box wider (or, at 90°/270°,
  narrower) than the canvas really is and every label was sized off by that
  factor — visibly shrinking at 45° and GROWING at 90°. Covered by
  `tests/test-labels.js` ("Labels - size is independent of zoom and rotation")
  and end to end by `tests/e2e/label-size-rotation-invariant.mjs`, which drives
  `drawAllOverlays` over a real wrapper carrying `applyZoom`'s transform at
  seven angles and three zoom levels (confirmed failing pre-fix, 19px at 45°
  and 32px at 90° against a correct 24px).
- Skeleton drawing: `drawSkeleton`, `drawReprojectedSkeleton`,
  `drawReprojectionErrors`, `drawSelectionHighlight`,
  `drawHoverHighlight`, `drawDragPreview`, `drawInstanceLabels`,
  `drawInstanceTypeIndicator`, `drawUnlinkedInstances`, `drawViewNameLabel`.
  **`drawViewNameLabel(ctx, text, options)`** draws a camera name **top-left**,
  behind "Export Video Overlays" ▸ Layers ▸ **Render Video Names** — `layers.videoNames`,
  **default ON** (a multi-camera composition is close to unreadable unlabelled, so the
  caption is the expected output rather than an opt-in), and the first entry
  in that group). The composed `.mp4` otherwise carries no labels at all — the
  dock's per-tile name chip is UI chrome and is never encoded — so a five-camera
  composition would ship as five anonymous rectangles. **Top**-left so it lands
  exactly where that chip sits: the render then carries the same tag the
  composition shows, just without the close X, and in the preview the two coincide
  instead of reading as two labels. (It was bottom-left first, on the reasoning that
  the corner was free — which put a *second* visible label on each tile.) No
  collision with `drawLegend`, which owns the top-**right**. `options.corner:
  'bottom-left'` is retained for a caller that wants it out of the way.
  The font scales off `ctx.canvas` rather than being fixed: the same tile
  is drawn at preview size and again at output size, and a fixed size is unreadable
  in one or hairline in the other (`drawLegend`'s fixed 28px does drift this way —
  deliberately not copied). It resets to the identity transform and `filter:'none'`
  itself, and callers must invoke it OUTSIDE any view transform so a caption stays
  upright on a rotated camera.
  **`drawUnlinkedInstances` "?" badge is suppressible:** the amber `?` on an
  unlinked instance is an **editing affordance** ("assign me"), so
  `options.showUnlinkedBadge` (**default `true`** — a missing option must never
  silently strip it) turns it off while KEEPING the other two unlinked cues, the
  dashed edges and the reduced opacity. Hiding the badge must never hide the
  detection. `drawFrameOverlays` spreads the flag into `unlinkedOpts`, which both
  of its `drawUnlinkedInstances` passes (`typeFilter: 'predicted'` then `'user'`)
  receive, so **one flag covers both types** — the badge block sits outside the
  `isPredicted` branch, and a per-type regression would only show on one pass.
  Two callers set it: the Visibility panel's `visUnlinkedBadge` toggle (via
  `getVisibilitySettings`) and `overlayOptionsFrom` for video export, which pins
  it `false` for the same reason it nulls selection/hover/drag — nobody watching
  an `.mp4` can act on an editing prompt. Covered by
  `tests/test-unlinked-badge.js` (pixel-level, both types, plus a whole-canvas
  diff asserting **nothing outside the badge disc changes**) and
  `tests/e2e/unlinked-badge-toggle.mjs` (the checkbox → settings → repaint →
  localStorage → reload chain).
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
  **`drawUnlinkedInstances` draws the track/identity NAME pill.** It used to
  draw only the `?` badge and per-NODE names, so the "track_1"/"id_1" pill was
  the one cue that vanished the instant an animal was ungrouped — and ungrouping
  is exactly what the ID-correction workflow asks for (luc3d #201: ungroup, fix
  the view that's wrong, regroup). The reported symptom was "the label
  disappeared from the mouse altogether so he couldn't assign it to an ID":
  with several detached detections on screen and no names on any of them, there
  was no way to tell which one matched which Ungrouped Instances row. Nothing
  about the DATA changes across an ungroup — `unlinkGroup` keeps `trackIdx` and
  retains the identity — so the name was always resolvable; only the drawing was
  missing. The pill now comes from a shared **`drawNamePill(ctx, cp, text,
  color, fontSize)`** (module-private) that `drawInstanceLabels` also uses, so
  the linked and unlinked states put the SAME pill at the SAME anchor and an
  ungroup cannot move it either. It also save/restores `textAlign`/`textBaseline`,
  which `drawInstanceLabels` had been leaving to the canvas default (true only
  for the first instance of its own loop, and false for the unlinked caller,
  which interleaves the `center`-aligned badge and `left`-aligned node labels).
  Gating mirrors the linked counterparts exactly: user instances follow the
  Visibility panel's show-labels (section 4a), predicted ones appear only in ID
  mode (section 3a). This reaches the overlay-video export too, via the same
  `userOpts.showLabels`.
- **`getInstanceLabelName(instance, session, cameraName, useIdentity, frameIdx)`**
  (exported) — the TEXT counterpart of `getInstanceColor`, resolved in the same
  order so the two can never name different animals: ID mode + tracked → the
  per-frame `frameIdentityMap` identity; ID mode + TRACKLESS → the identity
  retained on `Instance.identityId` (luc3d #201 — `getInstanceColor` already
  colors from it, so omitting it here would paint an identity color under a
  track name); otherwise the raw track name, including `drawInstanceLabels`'
  `'Track N'` fallback. Returns `null` only when there is genuinely nothing to
  name (no track AND no identity), and the caller then draws no pill rather than
  inventing a positional index. An explicit per-frame "no identity" marker
  resolves to null at step 1 and falls through to the track name — the same
  thing the linked path does, so an ungroup doesn't change that either.
- **`resolveLabelIdentity(session, instance, group, cameraName, frameIdx)`**
  (module-private) — the identity a LINKED instance's label should name, in the
  same two steps `getGroupColor` uses: the per-frame map, then the parent
  group's own `identityId`. Only the COLOR path had step 2, so a group with an
  identity but no per-frame entry yet — which is **every group made with the
  Group button**, since `createGroupFromUnlinked` sets `identityId` without
  writing the map — was drawn in the identity's color under the raw TRACK name
  ("track_1", in green-for-id_1). Used by both label passes (3a predicted, 4a
  user).
- **`drawInstanceLabels` `options.nameByIndex` / `options.colorByIndex`** —
  per-instance names/colors, indexed like `instances`, taking precedence over
  the trackIdx-keyed `trackNames`/`trackColors`. Those maps CANNOT express two
  instances in one view that share a trackIdx (a real state the raw per-camera
  tracker produces — the same one `getGroupColor`'s `writtenThisFrame` guard and
  `drawUnlinkedInstances`' dup-index shading exist for), nor a trackless one,
  whose `null` key collapses every trackless instance onto a single entry. The
  color path already told such instances apart per instance; the label path was
  last-write-wins, so two differently-colored animals could carry the same name.
  Regression tests: `tests/test-unlinked-track-label.js` (grouped baseline →
  ungroup keeps the name, in Tracks AND ID mode; trackless retained identity;
  no pill when there is nothing to name; two grouped instances sharing a
  trackIdx get their own identity names — all four confirmed to fail pre-fix,
  the collision case producing `["track_0","track_0"]`).
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
  Node Trails** submenu or the toolbar's **Trails** button (Off / ¼ s / ½ s / 1 s / 2 s
  → `state.trailSeconds`, drawn as `state.trailLength` = seconds × fps frames;
  see `ui/trail-presets.js` and `ui/ui-wiring.js`).
  **Performance (it runs per view, per playback redraw):**
  - `trailWindowFrames(frameGroups, frameIdx, trailLength)` (exported) finds the
    window by **walking back** from `frameIdx` — ~`trailLength` lookups — instead
    of scanning and sorting every loaded frame, which on a project held in memory
    (HardFight: 36,000 frames) cost ~3 ms of every redraw as soon as trails were
    on and grew further into the video. After `frameGroups.size` steps without
    filling the window (a sparse project) it falls back to the scan, so it is
    never worse than before.
  - **On a LAZY project a missing frame is not an unlabelled one.**
    `frameGroups` there is a residency window, so `drawNodeTrails` passes
    `residentOnly` (`!!session.lazyLoader`) and the window ENDS at the first
    non-resident frame instead of skipping it. Skipping it was the bug: a seek
    hydrates its target and the frames ahead of it, not the ones behind, so the
    walk (or its scan fallback) reached frames still resident from before the
    jump and every trail ran straight from each animal's position now to where
    it was thousands of frames earlier — seen on picking a row in the ID
    Switches tab. The draw path fills the window first
    (`ensureLazyTrailWindow`, `pose/triangulation.js`), so the rule only
    shortens a trail while its frames are still arriving. An EAGER project
    keeps SLEAP's sparse semantics. Covered by `tests/test-node-trails.mjs` §11
    and `tests/e2e/lazy-trail-window.mjs` (real `navigateToFrame` →
    `drawAllOverlays`, a forward and a backward jump; it fails on the old
    build with a 350 px segment per node).
  - Segments are **batched per age step**: every node's newer→older segment at
    window index k has the same style (alpha / width / historical color of k),
    so they share one path and one `stroke()` — `numNodes` times fewer strokes.
    Endpoints are transformed once each. Drawn segments and their styles are
    identical to the per-segment version (checked on 400 random scenes); the
    only difference is that overlapping same-age segments of one track no
    longer double their alpha where they cross.
  - Measured with `tests/e2e/_bench-playback.mjs` `SCENARIOS=...,trails<N>,...`.
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
  **Reprojection node color ignored the Visibility panel on the raw-fallback
  path (luc3d #209).** Step 2 has two ways to draw a group's reprojection:
  a materialized `reprojectedInstances` `Instance` (built by
  `storeReprojectedInstances`/`getOrComputeReprojectedInstance`,
  `pose/triangulation.js`), or — when that Map is still empty, which is
  ALWAYS true right after a bulk `triangulateAllFrames` sweep (BA is
  typically run this way via "Triangulate All"; it deliberately skips
  materializing `reprojectedInstances` for memory reasons) — a fallback that
  draws straight from `group.reprojections`' raw points via
  `drawReprojectedSkeleton`. `reprojXColor` (the marker/X color, computed
  from `options.reprojNodeColor`) was a `var` declared only inside the
  sibling `if (reprojInst)` branch; being function-scoped it still existed
  in the `else` (raw-fallback) branch but was never assigned there, so it
  was `undefined` — and `drawReprojectedSkeleton`'s `options.color ||
  '#ff6b6b'` silently hardcoded every such reprojection to `'#ff6b6b'`,
  ignoring white/black/track entirely. Because `'#ff6b6b'` is also
  `TRACK_COLORS[0]`, this read exactly like "reprojections are forced into
  track color" — and combined with `ui/rendering.js`'s lazy fill toggling a
  group in and out of the "has `reprojectedInstances`" state across
  redraws, produced a red/white flash while scrubbing BA-triangulated
  frames. Fixed by hoisting the `reprojXColor`/`isSelected` computation
  above the `if`/`else` so both branches share it. Regression test:
  `tests/e2e/reprojection-fallback-color-setting.mjs` (drives the raw-
  fallback branch directly with a group that has `reprojections` but no
  `reprojectedInstances`, and asserts the marker's `fillStyle` matches
  `reprojNodeColor` — confirmed failing pre-fix, both `'black'` and
  `'white'` settings drawing `'#ff6b6b'`, and passing post-fix).
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
- `setReprojErrorVisible(visible, opts?)` — show/hide the reproj-error info
  column. Showing it ticks the Reprojections and Errors boxes unless
  `opts.checkBoxes === false`.
- `showReprojectionsOnly()` -> `boolean` — after Triangulate All (#243): User,
  Predictions, Errors off, Reprojections on, each changed box firing its own `change`
  event (so the deselect-hidden-instance handler and redraw run as for a
  click); returns whether anything changed. `REPROJ_ONLY_NOTE` is the status
  suffix the callers append when it did. The four Triangulate All endings
  (`triangulateAllFrames` windowed + in-memory, `groupByIdentityAndTriangulateAll`,
  `groupByTrackAndTriangulateAll`) call `setReprojErrorVisible(true, {checkBoxes:
  false})` then this, so a run is compared with the USER's boxes, not with
  Errors just re-ticked.
- `showPredictedOnly()` -> `boolean` — the tracking counterpart: after Track
  Frame / Track Frame Range / Track All (`pose/tracker.js`) Predictions on; User,
  Reprojections, Errors off, by the same change-event mechanics (shared private
  `setToolbarLayers`). `PREDICTED_ONLY_NOTE` is its status suffix.
- `getVisibilitySettings()` — reads per-view checkbox state from the DOM.
  Includes **`showUnlinkedBadge`** (the Visibility panel's *Unlinked Instances ▸
  Show "?" badge* toggle, `#visUnlinkedBadge`), passed straight through to
  `drawFrameOverlays` in `drawAllOverlays`. Read via a `checkVal(id, fallback)`
  helper that mirrors the existing `styleVal` tolerance and **defaults `true`
  when the element is absent**: the headless runners build a partial DOM, and a
  bare `.checked` on a missing node throws and takes the whole render down.
  It is registered in `ui-wiring.js`'s `visCheckIds` (so it persists to
  `localStorage`, and an older stored blob without the key keeps the HTML
  `checked` default — no migration) and in the checkbox change-listener list (so
  toggling repaints immediately rather than waiting for the next frame step).
  Unlike the other entries in that list it needs no deselect sweep: it changes
  only what is painted, never which instances exist.
  Each of `userOpts` / `predictedOpts` / `reprojOpts` now carries a `nodeStyle`
  (`'circle'`/`'x'`/`'triangle'`/`'square'`) read from the per-section Node
  Style button group (`visUserNodeStyle` / `visPredNodeStyle` /
  `visReprojNodeStyle`). Defaults: user `'circle'`, predicted `'x'`, reproj
  `'circle'` — reproj matches the 3D viewer marker (also `'circle'`) per
  issue #95. (`drawReprojectedSkeleton`'s own primitive fallback stays `'x'`
  for direct callers; the user-facing default comes from here.)
- `drawAllOverlays(frameIdx, viewFrames?)` — main per-frame redraw across every
  view. Optional `viewFrames` (`{ viewName: frameIdx }`, passed by the
  per-refresh playback loop in `loading/video.js`) draws each view's overlay at
  the frame ITS canvas shows (from that view's captured `VideoFrame`), so
  overlay and video agree per camera even when cameras are a frame or two
  apart; a view whose frame isn't hydrated (lazy) falls back to `frameIdx`, and
  the selection highlight only shows where the selected group exists on that
  view's frame. The lazy reprojection fill is the private
  `fillLazyReprojections(fi, groups)`, run for `frameIdx` and once for each
  other per-view frame. Threads
  `state.colorByIdentity` and `state.trailLength` (node-trail length, issue #102)
  into each `drawFrameOverlays` call. With trails on in a lazy project it first
  calls `ensureLazyTrailWindow(frameIdx, state.trailLength)`
  (`pose/triangulation.js`), so the trail drawn right after a seek has the
  frames BEHIND the target, which the seek's own hydration does not load; a
  worker-backed loader's frames arrive later and trigger one redraw. A no-op
  during playback (those frames were just played). It also computes the per-view
  **`labelDisplayScale`** (backing-store px per on-screen CSS px) that
  `overlays.js` sizes node/track labels with: `overlayCanvas.offsetWidth` — the
  LAYOUT width, which no CSS transform touches — times `view.zoom.scale`, which
  must stay in because the backing store was just grown by the same factor a few
  lines above. Deliberately **not** `getBoundingClientRect()`: `applyZoom`
  rotates the whole `.canvas-wrapper`, and a rect is the transformed element's
  axis-aligned bounding box, so measuring there made labels shrink at 45° and
  grow at 90°. See `ui/overlays.js` ▸ `resolveLabelDisplayScale`.
  It passes **`labelRotation`** alongside it — `Math.round(view.rotation)`, the
  angle labels cancel so they read horizontally (issue #162). Rounded because
  the Shift+R+Arrow chord advances `view.rotation` fractionally every animation
  frame while the repaint that keeps labels upright is triggered off this same
  rounded value changing (`ui/ui-wiring.js`), so drawing the rounded angle is
  what makes the two agree; the residual is under half a degree.
  It passes **`showLegend: false`** unconditionally and calls
  **`syncViewLegends`** (`ui/view-legend.js`) after the per-view loop instead:
  the Display Legend key is pane DOM now, outside the rotating
  `.canvas-wrapper`, so it stays upright and anchored to the VIEW rather than to
  the video box. Driving it from here means it inherits the overlays' triggers,
  including the Visibility checkbox handler that already ends in a redraw. **Playback throttle (issue #115):** the
  skeleton overlays + video redraw every frame, but the two *auxiliary* updates —
  `updateFrameInfo` (info-panel DOM + reproj-error aggregation) and
  `timeline.setCurrentFrame` (a full timeline-canvas `redraw()`) — are coalesced
  to ~10 Hz (`AUX_UPDATE_MS`) while `state.isPlaying`, since neither is legible at
  playback speed and both were a per-frame cost capping buffered-playback fps.
  When paused (seek/step) they run every call; `VideoController.stopPlayback`
  fires one final unthrottled `drawAllOverlays` so the panel/playhead settle to
  the exact stop frame. While playing, the timeline call passes
  `{ playback: true }` so the timeline only moves its playhead over a cached
  snapshot instead of a full redraw (see `ui/timeline.js`).

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

  This fill stays **outside** the collapsed-info-panel gate (see
  `ui/panel-visibility.js`). It is shared, not panel-only: the canvas
  reprojection markers, the 3D viewport and the `.slp` export all read the
  `_grp.reprojections` / `reprojectedInstances` it produces, and it fires only
  once per group — skipping it for a hidden panel would blank the canvas AND
  permanently deny the panel numbers it could never recompute. The gate lives
  one level down, in `updateFrameInfo` itself, which is where the panel
  *consumes* `state.triangulationResults`.
- `updateFrameCounters()` — the status bar's Camera / Labeled Frames /
  Instances / Triangulated, over the **WHOLE project**, lazy ones included.
  It used to walk `session.frameGroups`, which on a lazy project is the
  resident window — after Track All + Triangulate All on a 108,000-frame,
  8-camera project it read "Labeled Frames: 5789" and "Triangulated: 5789"
  (the #194/#195 resident-only bug class). The counting rules and the
  whole-project baseline live in `ui/frame-counters.js`; this function owns
  WHICH camera (`interactionManager.lastInteractedView`, else the first view),
  WHEN to (re)build the baseline, and the DOM. Per call it is
  O(resident frames) — `countFrameCounters` counts resident frames live and
  takes everything else from the cached baseline — the same work the old loop
  did. Still skipped during playback (`updateStatusBarForFrame`,
  `ui/info-panel.js`).

  The baseline is cached per session in a `WeakMap` (so a closed project and
  its store are never retained by the status bar), with one camera half per
  view visited. Building it is ~100 ms at 108,000 frames x 8 cameras, nearly all
  memory latency on each frame's groups, so:
  - **Synchronous** only when there is none: the first update of a session
    (or after its `lazyLoader` changes) and the first time each view becomes
    active (`computeLazyCameraBaseline`) — once per view per session.
  - Otherwise **rebuilt in the background** (`runCounterRebuild`), 250 ms after
    the last update that asked, in 8,192-frame slices (≤ ~8 ms each) via
    `createFrameCounterBaselineBuilder`. An update asks when it redraws the
    SAME frame as the previous one (or a rebuild is still pending, e.g. one
    abandoned to playback): every data change — an edit, Track All, Triangulate
    All, a session-wide delete — redraws the current frame, so the counts follow
    all of them with no per-operation invalidation (Track All does not even
    mark the project dirty), while a redraw on a NEW frame is navigation and
    costs no whole-project work. A rebuild in flight sets `again` instead of
    restarting, so a stream of updates cannot starve it. The other views'
    halves are carried over — they can only lag a bulk operation — UNLESS the
    rebuild shows this view's non-resident part moved
    (`nonResidentCameraCounts`), which means one just happened: then they are
    dropped and each is recomputed exactly on its next activation. An edit to
    the current frame moves only resident frames, so annotating keeps view
    switches free.
  - An edit to the current frame shows immediately — resident frames are always
    counted live.

  **Plane placements draw last.** After `drawFrameOverlays` returns for a view,
  the loop calls `drawPlaneOverlays(view)` (`ui/plane-definition.js`) on the
  same overlay canvas. The order is load-bearing: `drawFrameOverlays` opens
  with a `clearRect`, so planes drawn before it would be wiped. Planes are
  frame-independent (static scene geometry), so this runs on every frame
  regardless of the current `FrameGroup`, and in every mode — not just
  Defining Plane Mode. Pinned by `tests/e2e/define-plane-mode.mjs`, which
  samples overlay pixels.

  **Defining Plane Mode's toolbar lock is re-asserted here.** The toolbar block
  near the top of `drawAllOverlays` RECOMPUTES `tbGroup.disabled` /
  `tbEditGroup.disabled` from the pose selection on every overlay draw, and the
  mode redraws constantly — so `applyPlaneModeToolbarLock()`
  (`ui/plane-definition.js`) is called right after it rather than only at
  `enterPlaneMode`, where the lock would survive until the first mouse move. A
  no-op when the mode is off. Pinned by
  `tests/e2e/plane-mode-toolbar-lock.mjs` §3, which first proves the draw really
  does reach that code (without a session `drawAllOverlays` returns early and
  the assertion would be vacuous).

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
- `./frame-counters.js` — `computeFrameCounterBaseline`,
  `computeLazyCameraBaseline`, `createFrameCounterBaselineBuilder`,
  `countFrameCounters`.
- `./plane-definition.js` — `drawPlaneOverlays`, `applyPlaneModeToolbarLock`.
  **Circular** (that module imports `drawAllOverlays` back); safe because both
  call sites are inside function bodies.

**Imported by.** `pose/triangulation.js`, `pose/tracker.js`,
`pose/initialization.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `loading/session-loader.js`,
`ui/identity-assignment.js`, `ui/export-modals.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`, `ui/plane-definition.js`,
`ui/view-align-modal.js`.

**User-facing features.** Every overlay redraw — after seek, drag,
re-triangulate, identity assignment, or visibility-toggle change.

---

### ui/plane-dialog.js

**Purpose.** The small blocking-error / confirmation modal the plane and origin
flows share.

Split out of `ui/plane-definition.js` when that file hit 4,474 lines. It was the
easiest thing in it to lift: it touches no plane state, no model and no
viewport. Four call sites reach it — the fit refusal, the Triangulate
locked-nodes report, node deletion and `ui/origin-definition.js` — which is
what makes a shared home the honest one rather than an accident of which
feature needed it first.

A **LEAF module**: it imports nothing.

**Key exports.**
- `showPlaneDialog({title, message, confirmLabel?, onConfirm?})` — OK-only when
  there is no `onConfirm`, Cancel/confirm when there is. **Esc CANCELS**, per the
  project modal rule, so an accidental dismissal can never apply the thing the
  user was still deciding about.

**Imported by** `ui/plane-definition.js` (which also re-exports it, so the name
stays reachable at its original path), `ui/plane-nodes-panel.js`,
`ui/plane-angle.js`, `ui/origin-definition.js`.

### ui/plane-toolbar-lock.js

**Purpose.** Disable the pose-annotation toolbar while Defining Plane Mode is
on, and restore it exactly as it was on exit.

Split out of `ui/plane-definition.js`. Self-contained: it reads one flag
(`planeState.active`) and otherwise only touches toolbar DOM, with no fan-in
from the rest of the panel.

**Key exports.**
- `applyPlaneModeToolbarLock()` — **idempotent, and must stay so**, because
  `drawAllOverlays` re-derives `tbGroup.disabled` / `tbEditGroup.disabled` from
  the pose selection on every overlay draw and the mode redraws constantly. Each
  button's PRIOR `disabled` and `title` are snapshotted on the transition only —
  re-snapshotting on the re-assert would record the LOCKED state and make the
  restore a no-op.

Adding a button to the lock means adding its id to `PLANE_LOCKED_TOOLBAR_IDS`;
if it opens a menu, its wrapper also needs `PLANE_LOCKED_DROPDOWN_IDS`, since a
`.tri-dropdown` menu opens on hover and its items are `div`s, so `disabled` on
the button reaches neither.

**Imports** `planeState` from `ui/plane-definition.js` — circular, and safe only
because the binding is read INSIDE the function body. **Imported by**
`ui/plane-definition.js` (re-exported) and, through that path,
`ui/rendering.js`.

### ui/plane-overlays.js

**Purpose.** Draw the placed planes onto a view's 2D overlay canvas.

Split out of `ui/plane-definition.js`. Pure rendering: it reads the model and
the interaction state and writes pixels, and nothing in the panel calls back
into it.

**Key exports.**
- `drawPlaneOverlays(view)` — called from `drawAllOverlays` AFTER
  `drawFrameOverlays`, which begins with a `clearRect`, so drawing earlier would
  be wiped. Planes are drawn in **every** mode, not just Defining Plane Mode —
  they are geometry the user annotated, and hiding them outside the mode would
  make them look lost. Only the SELECTION and HOVER decorations are mode-gated.
  Fills and edges are per PLANE; NODES are drawn once each over the union, since
  a corner two planes share is one node with one 2D point.

**What is drawn outside the mode is the user's to choose**, through the
Visibility panel's `Planes` section: `planeVisibility`
(`ui/plane-visibility.js`) gates the plane BODY (fill, edges, plane name) and
the NODES separately, and forces every part on while the mode is active. It
decides WHETHER a plane is drawn, never HOW — the fill still comes from
`plane.filled` alone, so a shown plane looks the same in both modes.

**Imported by** `ui/plane-definition.js` (re-exported, which is how
`ui/rendering.js` still reaches it unchanged). **Imports** `planeVisibility`
from `ui/plane-visibility.js` beside the hub bindings.

### ui/plane-visibility.js

**Purpose.** Which PARTS of the annotated planes are drawn, in which
representation — the one reader of the Visibility panel's `Planes` section.

**Key exports.**
- `PLANE_VIS_IDS` — the four checkbox ids (`visPlanes2D`, `visPlanes3D`,
  `visPlaneNodes2D`, `visPlaneNodes3D`), keyed by the field each produces.
  Exported so `ui/ui-wiring.js`'s `visCheckIds` persistence list and the tests
  name them from here: a toggle missing from that list still works and silently
  forgets, which is invisible until the next reload.
- `planeVisibility(modeActive)` → `{planes2d, planes3d, nodes2d, nodes3d}`.

Three things it decides, and each has a reason:
- **Defining Plane Mode overrides all four.** The panel's tables, the 2D
  placement drags and the 3D corner drags all act on parts the user has to be
  able to see, so honouring a toggle inside the mode would hide the thing being
  edited. These toggles are about the DEFAULT mode, where a plane is scenery.
- **They decide WHETHER a plane is drawn, never HOW.** A shown plane keeps its
  own colour, edges and `Fill`, so the two representations and the two modes
  cannot disagree about what a plane looks like. There is deliberately no fill
  override: `plane.filled` is project state written to the `.slp`, the `Fill`
  button is the one thing that sets it, and a plane gaining a fill because it
  became visible is the same confusion `mesh-membership-highlight.mjs` pins
  against for the mesh-object highlight ("no fill of its own"). The four
  toggles themselves ride `localStorage.visibilitySettings` with the panel's
  other global appearance prefs — browser-local display taste, not project
  state, so `save-golden-digest.mjs` cannot move.
- **A missing checkbox reads as ON.** The headless runners build a partial DOM,
  and a harness that silently renders nothing and passes is far harder to spot
  than a stray plane.

**NO IMPORTS, deliberately** — it is read from inside the plane panel's
`plane-definition` ↔ `plane-overlays` cycle and from `ui/ui-wiring.js`, and a
module with no edges of its own cannot be the one that closes a loop.
**Imported by** `ui/plane-overlays.js` (2D), `ui/plane-definition.js`
(`syncPlanes3D`) and `ui/ui-wiring.js` (the ids, for persistence and the
change listeners). Covered by `tests/e2e/plane-visibility-toggles.mjs`.

### ui/plane-nodes-panel.js

**Purpose.** Section 1 of the Define Planes panel: the global Nodes table, the
padlock (pin) picker, the typed x/y/z editor and node deletion.

The largest cluster split out of `ui/plane-definition.js` (~880 lines) and the
one with the most self-contained state — the pin popover singleton is read and
written nowhere else in the app.

**The model state stays in the hub.** `planeState`, and the one
`new PlaneModel()` on it, is imported and never redeclared: a second copy would
diverge silently, since the tests assert behavior rather than object identity.

**Key exports.**
- `renderNodesTable()` — one row per pool node; rebuilt on almost every
  interaction, which is why selecting a row must NOT rebuild it (see
  `setSelectedNode` in the hub).
- `renderPinInfoButton()` — wired ONCE, guarded by `dataset.wired`; it is not a
  per-repaint renderer despite the name.
- `renderFrozenWarning()`, `planeLockWhere(lock)` — the latter is shared with
  the hub's 3D corner drag, which reports where a plane-locked node was pulled
  back to.

The pin picker REPOSITIONS on scroll rather than dismissing: a `scroll` event
arrives a frame late, so dismissing made it impossible to open on a row you had
just scrolled to.

**Imports** `state`, `setInfoTip`, `showPlaneDialog`, `setStatus`/`markDirty`,
`PIN_STATES`, `nodeFreezeState`, `reprojectPointCamera`, `isOriginModeActive`,
and from the hub `ICON_PIN`/`ICON_INFO`/`makeDeleteButton`/`setEmptyState`/
`redraw`/`planeModel`/`planePool`/`planeState`/`refreshPlanePanel`/
`refreshTriangulationErrors`/`syncPlanes3D`/`syncSelectedNode3D`. Every hub
binding is read inside a function body only.

### ui/plane-editor-panel.js

**Purpose.** The EDITOR half of the panel's **Planes** section: the name
field, the member list, the "+ Add" existing-node picker and the edge pickers,
for whichever plane is selected. It renders directly under the roster
(`ui/plane-list-panel.js`) inside the same `<details>`.

**One section, two modules.** The roster and the editor are one
`#planePlanesDetails` in the markup and two modules here, split by what they
render: the roster draws EVERY plane, this draws the SELECTED one. They were two
top-level sections as well — "Edit Plane" above "Planes" — until the reader
having to hold a plane in their head while scrolling between the list that picks
it and the controls that act on it made the case for merging them.

**It does not CHOOSE the plane.** It used to: a plane dropdown was its
top row, listing every plane by id with `+ New Plane` pinned last and a
disabled "— select a plane —" placeholder holding the value when nothing was
selected. That made it a **second writer of `planeState.selectedPlaneId`**,
which the Planes table already owns — and the price of the
duplication was all on the control: a placeholder that is not a plane, an
ACTION sitting among the planes as if it were one, and a list whose labels are
user-editable names keyed by id so a rename relabels rather than re-selects.
The section now matches **3D Mesh Objects**, where the table selects and one
`+ New` button creates: a plane is picked by clicking its row in the roster, and
`+ New Plane` (`#btnNewPlaneSkeleton`, between the roster and this editor, and
the only one in the panel) creates and selects. `renderEditor` reads
`getSelectedPlane()` and renders; it writes no selection state at all.

**Key exports.**
- `renderEditor()` — the module's ONLY export and its entry point, called by
  the hub's `refreshPlanePanel`. It also calls into the Nodes section
  (`renderNodesTable` / `renderFrozenWarning`); that is one-directional, as
  that module never calls back.

**Imported by** `ui/plane-definition.js`.

### ui/plane-list-panel.js

**Purpose.** The ROSTER half of the panel's **Planes** section: the Planes
table, its action row, the `Views: annotated / total` fraction and the per-plane
placements sub-row. The table is also the DRAG SOURCE that places a plane onto a
video view, and **the one control that SELECTS** which plane the editor below it
(`ui/plane-editor-panel.js`, same `<details>`) edits.

Cohesive by what it renders, not by size: everything here draws or wires one
Planes row, and nothing here solves anything — Triangulate and Fit are reported
through the hub's `triangulatePlaneAndReport` / `fitPlaneAndReport`.

**Key exports.**
- `renderPlanesTable()`, `renderActionRow()`, `renderOriginButton()`.
- `ICON_TRIANGULATE` / `ICON_MESH` / `ICON_FIT` — the action glyphs, also set by
  the hub's one-time wiring.
- `annotatedViewStats(plane)` stays private to the module but is the reason it
  exists: it counts **hand-placed** views only, never reprojected ones, because
  `Triangulate` reprojects a plane into views it was never placed on and
  counting those would make the fraction read full after one Triangulate and
  never say anything again. It uses the SAME test `triangulatePlane` applies to
  choose contributing views, so the number and the solver cannot disagree.
  Pinned by `tests/e2e/plane-views-column.mjs`.

**Imported by** `ui/plane-definition.js`.

### ui/plane-definition.js

> **This module was SPLIT.** It reached 4,474 lines, so the panel's parts and
> three cross-cutting helpers now live beside it:
> `ui/plane-nodes-panel.js` (Nodes), `ui/plane-list-panel.js` (the Planes
> roster) and `ui/plane-editor-panel.js` (the selected plane's editor, under
> that roster in the same section), plus
> `ui/plane-dialog.js`, `ui/plane-toolbar-lock.js` and `ui/plane-overlays.js`.
> The hub kept the model accessors, the placements, the two solver controllers
> (triangulate and fit), the mode lifecycle, `refreshPlanePanel`, the
> interaction callbacks and the one-time wiring — the orchestration that drives
> the sections.
>
> **`planeState` did not move, and must not.** It is declared here and holds the
> one `new PlaneModel()`; a second copy would diverge silently, since the tests
> assert behavior rather than object identity.
>
> **The export surface is unchanged** — every name importable from this path
> before the split still is, several by re-export. That is deliberate: ~25 of
> them are reached by `await import('/ui/plane-definition.js')` from the e2e
> tests, so the set of names this path resolves is part of the contract.
> A few module-private helpers (`redraw`, `makeDeleteButton`, `setEmptyState`,
> `ICON_PIN`, `ICON_INFO`, `syncSelectedNode3D`, `planeImmutableMask`) became
> exports because the new modules need them.
>
> Each new module imports its hub bindings CIRCULARLY and reads them inside
> function bodies only — never at module top level, where a circular import is
> still `undefined`. That rule is what makes this feature's existing cycles
> safe, and it is the one thing to preserve when adding to any of these files.


**Purpose.** "Defining Plane Mode" (**View ▸ Define Planes**) — the annotation
UI for re-defining the 3D viewer's origin. The end goal of that work is a
**translation vector + rotation matrix** that move the world frame onto a plane
the user marks up; this module owns how the user *draws* that plane and owns
nothing about the solve. The data model (`PlaneNodePool`, `PlaneSkeleton`,
`PlaneInstance`, `PlaneModel`) lives in `pose/plane-nodes.js` +
`pose/plane-data.js` and is partly re-exported here.

The pool, the planes and the origin frame live in app-session memory; the
per-view 2D lives on the active `Session`. **All of it is persisted** by
`import-export/plane-metadata.js`, so **every plane/node MUTATION calls
`markDirty()`** — an unsaved rename, re-colour, pin, placement, membership
change, fill, solve, drag or origin is a real unsaved change and the save dot
has to say so. The rule is per mutation, **not** per repaint:
`refreshPlanePanel()` / `syncPlanes3D()` / `redraw()` run for plenty of reasons
that change nothing on disk (entering the mode, a slider, a hover), and marking
from them would leave the dot permanently on. The node-size / edge-width /
3D-corner-size sliders are the deliberate exception — browser-local display
taste, not written to the project, so they must not mark it dirty.

**Nodes are GLOBAL and a node may be in several planes.** The pool holds every
plane node in the project; a plane is an ordered list of node IDs plus optional
edges. That is what lets two planes MEET along a shared line — the corners on
that line are one node with one 3D position and one 2D point per view, so
re-solving either plane cannot split the line apart.

**The panel's SHAPE is that model made visible: two SIBLING sections**, not a
nodes editor nested inside a plane editor. A node outlives the planes that
reference it, so presenting node creation as a sub-step of editing one plane
would misstate the model. That is the one split the panel keeps — choosing a
plane and editing it were two sections and are now one, because they are one
job.

1. **Nodes** (`#planeNodesDetails`) — the project-wide pool. A LIST, not a
   grid: each node is one row — chevron, colour, name, padlock, × — with **no
   column labels**, and expanding it reveals its 3D position and the planes
   using it. Everything in it acts on the NODE, so it applies to every plane
   using it, and there is **no membership column**. Carries `#planeNodeNameInput` + `#btnAddPlaneNode`,
   `#planeNodesEmpty` and `#planeFrozenWarning`. **`+ Node` mints a POOL node
   and touches no plane** — it neither creates one nor joins one (it used to do
   both), and a duplicate name is refused rather than silently minting a second
   node under a name the user identifies the first one by. A node in zero planes
   is a valid resting state, rendered `.plane-node-unused`. The × here
   **destroys** the node project-wide and confirms first when it is shared or
   pinned, naming the planes it will change.
2. **Planes** (`#planePlanesDetails`) — the roster AND the selected plane, in
   one section, in this order. Its summary is `Planes` plus the selected plane's
   name (`#planeEditorTitle`), so a folded section still says which plane the
   controls inside belong to.

   First the **roster**: `#planeSkeletonsTable` (the drag
   source, with the per-plane expander and placement rows; each row's meta reads
   `N off, N reprojected`, since a view Triangulate reprojected onto is placed
   like any other and would otherwise give no clue that its corners are the
   model's output rather than the user's annotation) and
   `#planeSkeletonsEmpty`. **This table is the only selector**: a row click is
   the one writer of `planeState.selectedPlaneId` besides `createPlane`, and
   everything below it re-reads that on every `refreshPlanePanel`. It used to
   share the job with a plane dropdown in a separate Edit Plane section; both
   are gone, so there is nothing left for it to agree with.

   Then **`+ New Plane`** (`#btnNewPlaneSkeleton`, in a
   `.panel-button-row.plane-create-row`, ruled off below), which sits OUTSIDE
   `#planeEditorContent` so it stays live with nothing selected — with no
   planes at all it is the only thing in the section that can do anything, so
   empty-stating it too would make this a dead end. It does NOT select either;
   it creates and the creation selects.

   Then the **selected plane**, which is `#planeEditorContent`, swapped for
   `#planeEditorEmpty` when nothing is selected
   ("click a plane in the table above, or + New Plane" — that string names both
   controls above it and tracks both): the EDITABLE name `#planeSkeletonName`
   (the one place a plane is
   renamed — the rename re-renders, so the roster and the section header
   follow live), then three foldables. `#planeMembersDetails`, a members table
   (`#planeMembersTable`, `NAME | COLOR swatch | ×`)
   whose × is `removeNodeFromPlane(…, {deleteIfOrphan:false})` — the REFERENCE
   goes, the node stays in the pool with its 3D, pin and 2D — plus an
   **add-an-existing-node** control (`#planeAddNodeSelect` +
   `#btnAddExistingPlaneNode`) listing every pool node not already in the plane,
   disabled with a spoken reason when there is none, and the **only** way a
   node enters a plane. `#planeEdgesDetails` (edges are per-plane), whose
   hint states that connections are OPTIONAL — triangulation and fitting are
   edge-independent and edges exist for visual reference, and to state a fill
   outline the convex hull cannot (a CONCAVE one). Without edges the fill hulls
   the plane's points, so an unconnected plane still fills correctly. And
   `#planeActionsDetails` (**Actions**): the shared `.plane-action-row`
   (Triangulate / Fill / Fit), `Set Origin` and `Set Angle Between Planes` —
   three loose button rows under the roster before, where they read as actions
   on the TABLE rather than on one plane.

   Last, and deliberately outside `#planeEditorContent`:
   `#planeAppearanceDetails` (**Plane Appearance**). It styles every plane in
   the roster rather than the selected one, so it must not empty-state with the
   editor.

**Planes has ONE labelled row, and it says `Name`.** There were two,
stacked and doing different things — a `Select Plane` dropdown over an
`Edit Name` field — and those labels had to name the ACTION because as
`Plane` / `Name` they named the noun twice and left which was which to be
discovered. With selection a roster row click the disambiguation is
moot: one row, labelled `Name`, the same word 3D Mesh Objects uses for the same
control. `.plane-name-row > span` stays a FIXED 72px column
(`flex: 0 0 72px` + `nowrap`). It no longer has two different-width labels to
hold apart, but it is what makes the input's left edge the same in the panel's
TWO `.plane-name-row`s — this one and 3D Mesh Objects' — so the two sections'
Name fields line up rather than each being sized by its own label.
`tests/e2e/plane-section-info.mjs` §6 asserts there is exactly one such row,
that it reads "Name", that no plane dropdown survives anywhere in the
section, and that `+ New Plane` sits above the field.
`tests/e2e/define-plane-mode.mjs` §2 asserts the section body's whole child
list, so a part that appears, disappears or moves fails there.

**Member node names are INDENTED off the table's left edge** (12px on
`#planeMembersTable`'s first column, header included).
`.plane-node-shared` paints its 2px accent bar INSIDE the row, so at the
table's inherited 6px of cell padding a shared node's name cleared the bar by
four pixels and the whole column read as flush with the edge. §7 of the same
test pins the padding and that the header matches it.

**Entering the mode mints NO plane.** `enterPlaneMode` re-selects an existing
plane so re-entry resumes where it left off, but creates nothing. A phantom
`plane_1` is indistinguishable from one the user made and forgot, so it gets
dragged onto a view and triangulated before anyone questions it; an empty
Planes list plus an empty-stated editor is the honest starting point. Pinned by
`define-plane-mode.mjs` §1b.

The add-an-existing-node dropdown is the **headline affordance**: picking a node
another plane already uses is exactly how an intersection is built. It replaced
the old per-row "In" checkbox, which is gone (and with it `.plane-node-member`),
and it is now the ONLY route from the pool into a plane — creating a node and
putting one in a plane are two separate acts, because a node is not owned by a
plane.

**Key exports.**
- `planeState` — `{ active, model, selectedPlaneId, selectedNodeId, nodeSize,
  edgeWidth, nodeSize3d, expanded, expandedNodes }`. `active` is the mode flag;
  `model` is the `PlaneModel` (pool + planes + per-view 2D);
  `nodeSize`/`edgeWidth`/`nodeSize3d` are ONE shared value each across every
  plane (Plane Appearance sliders — reference geometry you size once for
  legibility against your video, not per-plane styling); `expanded` is the set
  of plane ids whose placement dropdown is open. `selectedNodeId` is the pool
  node the Nodes table has SELECTED and the 3D view is ringing — transient
  (cleared by the next click anywhere else), so it is neither saved nor
  remembered, and deliberately separate from `expandedNodes`: opening a node's
  coordinates asks to READ something, selecting it asks to be SHOWN where it
  is.
- `planeModel()` — the model, with its 2D **bound to the active session**.
  Planes and nodes are project-scoped, but a `PlaneInstance` is 2D on one
  session's views, so the placements map lives on the `Session` and is adopted
  through `attachPlacements` whenever the active session changes (identity
  check, so the re-sync/prune runs once per switch, not once per call). Every
  accessor below goes through this.
- `planePool()` / `getPlanes()` / `getPlane(id)` / `getSelectedPlane()` /
  `createPlane(name)` / `deletePlane(id)`. **Deleting a plane keeps every one
  of its nodes** — nodes are plane-independent, so a node in no plane is an
  ordinary pool member that simply is not drawn anywhere, and auto-pruning it
  would throw away a pinned coordinate or a positioned 2D point as a side
  effect of tidying up. The Nodes table is the one place a node is destroyed.
- `planePoints3d(plane)` / `planeNodeNameAt(plane, idx)` / `planeHasAny3d(plane)`
  — the plane-ordered views of pool state that `ui/origin-definition.js` and the
  3D payload read.
- `getPlaneInstance(view)` / `getPlaneInstances(view)` / `placedPlanesOn(view)`
  / `placedViewsOf(plane)` / `placePlaneOnView(...)` / `unplacePlaneFromView(...)`
  — ONE `PlaneInstance` per VIEW, indexed by pool order, on
  `session.planePlacements` (`Map<viewName, PlaneInstance>`). Deliberately
  **not** keyed by frame: a plane is static scene geometry. Un-placing KEEPS
  the 2D (visibility is derived from the placed set), so re-placing restores
  exactly what the user positioned.
- `triangulatePlane(plane)` — solves the plane's 3D corners across every view it
  is placed on, writing them onto the NODES (`writePoints3dForPlane`, which
  refuses pinned ones) plus `plane.triangulation`. Follows
  `triangulateAndReproject` on the two points that matter for correctness —
  observations are **undistorted** before the linear DLT (only valid in ideal
  pinhole coordinates) and error is measured in each camera's **native** pixel
  space against the raw annotation. Right-click-disabled nodes are excluded per
  view. Pinned nodes keep their stored 3D (`mergeFrozenPoints3d` discards their
  DLT result) but their residual IS measured and reported separately
  (`summarizePlaneTriangulation`) — an out-of-sample residual saying "your
  pinned anchor no longer agrees with where you clicked". DLT only, no BA: a
  plane is 3-8 hand-placed corners. Returns `{ok:false, reason}` rather than
  throwing.
  - **Requires 2+ HAND-PLACED views, not 2+ placements.** Once triangulation
    reprojects a plane into the views it was not placed on, those views ARE
    placed but contribute nothing, so a placement count would let a plane
    annotated on ONE view return a confident answer built from one ray. The gate
    counts views with at least one usable (positioned, not nulled, not derived)
    observation, and `plane.triangulation.views` lists only those — otherwise
    `refreshTriangulationErrors` would average in a view whose residual is zero
    by construction.
  - Then it calls `reprojectPlaneIntoUnplacedViews`, and
    `triangulatePlaneAndReport` **redraws the 2D overlays** — triangulation now
    writes 2D, so without that the new placement is real, listed in the panel,
    and invisible until some unrelated event repaints.
- `reprojectPlaneIntoUnplacedViews(plane)` — writes the plane's solved 3D into
  the `PlaneInstance` of every view it is NOT placed on, flags those points
  `derived`, and places the plane there so it draws. Into the real instance
  rather than a read-only reprojection overlay because a plane is reference
  geometry the user is trying to get RIGHT: the useful thing is not only seeing
  where it lands in the other views but being able to grab a corner there and
  fix it, and dragging one is what turns it into evidence. Three refusals:
  - **Never claims to be evidence** — every written point is `derived`, so it is
    out of the next solve and out of the error average (see `PlaneInstance`).
  - **Never writes a mirrored ghost** — a point BEHIND a camera still divides
    through to a finite, plausible pixel (`reprojectPoint` does not check the
    sign of `w`), so each node is gated on `cameraDepth > 0`. A view with nothing
    in front of it is left alone and reported in `behindViews`.
  - **Never overwrites a view the user placed** — those hold the user's own
    annotation. The one exception is a point that is itself derived: those are
    REFRESHED wherever they are, because a reprojection left over from a solve
    two edits ago reads as current, which is worse than none.
  Off-frame reprojections are still written when the point is in front of the
  camera (a plane may legitimately extend past the frame edge; clamping would
  fake a corner). Cameras with no `state.views` entry are skipped — a placement
  nobody can see. Consequence worth knowing: un-placing a reprojected view is
  undone by the next Triangulate, by design.
- `planPlaneFit(plane)` / `applyPlaneFit(plane, plan)` / `fitPlane(plane, opts)`
  — the **second half** of the origin pipeline, split so the two outcomes that
  need the user happen before anything is written. With **no pinned node** it
  is `fitPlaneToPoints3d` + `projectPoints3dOntoPlane`, unchanged; with one or
  more it is `fitPlaneConstrained` + `projectPoints3dOntoPlaneConstrained`. The
  free case is deliberately NOT routed through the constrained solver (it would
  move floats for no benefit, and returns `not_constrained` to stop that by
  accident). Then the correction goes out to BOTH representations:
  `syncPlanes3D` for the viewer, and `reprojectPointCamera` into every placed
  view's 2D — **skipping pinned nodes**, whose 3D did not move and whose
  annotation is the user's, not the model's. Nodes toggled OFF still get their
  2D updated; the off flags are preserved. Derived points are rewritten too (so
  they keep agreeing with the fitted 3D) but excluded from the reported
  `movedPx`, which answers "how far did the fit move YOUR annotations".
  `refreshTriangulationErrors` re-derives the per-node errors afterwards, also
  skipping derived points.
  **`applyPlaneFit` stores the fit BEFORE the write, and the write goes through
  the `constrain` hook.** The flattened points are on THIS plane by
  construction, so the hook is a no-op for a corner this plane alone holds —
  and not a no-op for one that also belongs to another plane.
  `planeImmutableMask` deliberately reports only `locked`, so a plane-locked
  corner is one the fit is free to move, and fitting "right wall" used to drag a
  corner it shares with "Ground" off Ground, silently. The ORDER is the other
  half of it: a plane-locked corner of the plane being fitted is held by that
  plane too, so a hook running before `plane.planeFit` is replaced projects the
  corner onto the plane being superseded, which the fit then moves out from
  under it — leaving the corner 13 mm off the very plane it was just fitted to
  (`tests/e2e/plane-lock-holds.mjs` §4).
- **Blocking vs confirming.** `fitPlaneAndReport` dispatches on the result
  **CODE**, never on the message text. `no_anchor_3d` / `anchors_collinear` /
  `anchors_noncoplanar` / `underdetermined` BLOCK: the message goes to a dialog
  and the status bar and **nothing is mutated**. The `mutable_far_from_plane`
  warning CONFIRMS instead (the fit is valid; only flattening a corner metres
  onto it is drastic).
- **Stale-fit propagation.** After a successful fit the nodes that actually
  MOVED are found by an `Object.is` diff of input vs output (immutable entries
  are bit-identical and missing ones stay NaN, so the diff is exact), and
  `planesInvalidatedByFit` names the OTHER planes standing on them. Their
  `planeFit` is dropped and the user is told which ones went stale — a shared
  node moved by fitting plane B silently breaks plane A's fit otherwise.
- `syncPlanes3D()` — pushes every plane that has 3D into `viewport3d.setPlanes`
  (`points3dForPlane` / `planeEdgesLocal` / `planeFillOrder3d` /
  `planeNodeColors`, all in the plane's own node order). `polygonOrder` is the
  FILL's ring — the user's edge cycle or the convex hull — not membership order,
  so an interior corner is covered by the fill rather than notching it. Full rebuild, so it is
  also the REMOVE path. No-ops when `viewport3d` is null. Also the one place the
  3D drag callbacks are wired (idempotent), since the viewport is re-created per
  session load, and the one place the Visibility panel's `Planes` toggles reach
  3D: it sets `viewport3d.showPlaneSurfaces` / `showPlaneNodes` from
  `planeVisibility(planeState.active)`. The payload itself is unchanged by them
  — `filled` is still `plane.filled` alone, and every plane with 3D is still in
  it, because `_planes` is what a drag, the node marker and the mesh highlight
  resolve ids against. The payload's `editable` is
  `planeState.active && !isOriginModeActive() && !isAngleModalOpen() &&
  !!model.usableFitForPlane(plane)`, and that last term is a **USABLE** fit, not
  a stored one: gating the drag on a stored `planeFit` was the same mistake
  `usableFit` fixed for Set Angle, and it left a well-annotated plane — three
  solved corners, a perfectly good surface to slide along — refusing to be
  touched in 3D, because pinning any of its nodes had cleared the fit. The
  payload carries the usable fit as `planeFit` (the drag surface) and
  `fitted: !!plane.planeFit` separately, because **Set Origin's corner picker
  asks a different question** — "has the user DECLARED this plane's frame?",
  which `fittedPlanes()` counts — and widening the drag surface must not
  quietly make an un-Fit plane eligible to define the project's origin. That
  last term is also the 3D half of the Set Angle edit lock
  (see `ui/plane-angle.js`): that dialog is not modal, so the view under it stays
  orbitable, and a corner dragged while it is open would move the geometry its
  readout and its ghost were computed from. It then calls
  the private `syncMeshObject3D()`, which pushes the SELECTED 3D Mesh Object's
  member plane IDS into `viewport3d.setMeshMembership` (or `null` when nothing
  is selected). That lives here rather than in `ui/mesh-objects.js` because this
  is the function every plane mutation already routes through — anywhere else
  and the highlight would lag a node drag by a frame. **IDs, never geometry:**
  the derived geometry is built in the user's ORIGIN frame while the viewport
  group that draws it is in CALIBRATION world, so passing it drew the object
  displaced and rotated away from its own cage. The payload also carries
  `nodeIds` (`plane.nodeIds.slice()`, parallel to `nodeColors`), which is what
  lets the viewport resolve the SELECTED node — a pool-wide id — against
  corners it draws per plane.
- **Selecting a node** — `syncSelectedNode3D()` / `setSelectedNode(id)` /
  `applyNodeSelectionClass()` / `onDocumentClickForNodeSelection(e)` (all
  private). `syncSelectedNode3D` is `syncMeshObject3D`'s twin: it pushes
  `planeState.selectedNodeId` into `viewport3d.setSelectedPlaneNode` as an ID
  and is called at the end of `syncPlanes3D`, so a plane rebuild cannot leave
  the marker behind. `onDocumentClickForNodeSelection` is ONE `click` listener
  on `document`, in the CAPTURE phase, wired once in `setupPlaneDefinition`:
  anything carrying `data-plane-node-id` (the Nodes table's two rows, and a
  plane's per-node triangulation lines) selects that node, everything else —
  the rest of the panel, the 3D view, any canvas — clears it. Capture, because
  the row's own controls `stopPropagation` (the colour swatch, the padlock, the
  pin popover) and a click on one of those still means "this node"; one
  listener, because "clicked a node row" and "clicked anywhere else" are the
  same event seen from two sides, and wiring selection per row and clearing per
  surface leaves every surface nobody remembered to wire holding a stale
  marker. `setSelectedNode` deliberately does NOT rebuild the table — it
  toggles `plane-node-selected` on rows that already exist (`applyNodeSelectionClass`),
  because the click that selects a row is very often the click that is about to
  focus its name field, and a rebuild would throw that input away before the
  caret landed in it. A stale id is dropped in `renderNodesTable`, which every
  route that deletes a node ends in.
- **3D corner dragging** — `onPlaneNodeDragged3D` / `onPlaneNodeDragEnd3D`
  (private; installed by `syncPlanes3D`). The viewport has already constrained
  the position to the dragged plane's surface, so these mostly only write it:
  onto the node, then `reprojectPointCamera` into every placed view. **The 2D
  follows the 3D here** — the reverse of every other edit path, and the only
  consistent choice: a fitted corner is *defined* by the plane. Per-move work is
  `syncPlanes3D` + `redraw` only; the panel catches up on drag end. Two pin
  states, handled differently:
  - A **LOCKED** node is refused (once per drag, with the reason in the status
    bar): the payload marks draggability per PLANE, not per node, so the pin is
    enforced in the callback.
  - A **PLANE-LOCKED** node is not refused, it is **held** — the position goes
    through `constrainPoint3dForNode`, which gets the last word. The viewport's
    own constraint is the plane under the cursor and knows nothing about the pin,
    so without this a corner shared by two planes could be pulled off the other
    one by dragging it as a corner of this one. The corner then stops tracking
    the pointer, which is correct, and `onPlaneNodeDragEnd3D` says so — naming
    what actually holds it (a plane, the line two meet in, the point three meet
    at) instead of claiming "it stays on the fitted plane" about geometry that
    is only part of the answer. A corner in three planes cannot move at all,
    and the drag reports that rather than silently doing nothing.
  The gate is `usableFitForPlane`, matching the payload: the two have to ask the
  same question or a corner advertises a drag that then does nothing.
- **The Nodes list's shape** — `renderNodesTable` / `renderNodeDetailRow` /
  `renderPinInfoButton`. It is a LIST of nodes, not a grid of their properties,
  and everything about it follows from that: the colour leads the row because it
  is how you tell this corner from the others on every view and in 3D; the name
  is a borderless input that only looks like a field when you go near it; the
  coordinates are one chevron away rather than always on screen; and the pin is
  a padlock. Every column is named except the chevron, which names itself, and
  `Pinned` also carries `#planePinInfo`: what the THREE pin states MEAN is the
  one thing no icon can say. The delete × is a bare grey glyph rather than the
  shared red `.panel-btn` — right in a table you visit to remove something,
  wrong in a list of six nodes you are reading.
- **The pin picker** — `openPinPopover` / `closePinPopover` /
  `positionPinPopover` / `onPinPopoverReflow` / `schedulePinPopoverClose` /
  `setNodePin`, and `ICON_PIN`. The `<select>` that used to sit in every row had
  to be wide enough for the words "Plane-locked" and carried a second line
  naming the plane a held node is held in — two lines of chrome per row to say
  something that is usually "Unlocked". Now: one 15px padlock, coloured by
  state, and hovering or clicking it floats a three-state picker over the panel.
  Five things are deliberate:
  - **It floats** (`position: fixed`, anchored to the icon, appended to
    `document.body`). In-row would mean reserving three icons' worth of width
    the row only needs while the pointer is there, and `.plane-panel` scrolls —
    an absolutely positioned child would be clipped by its `overflow-y: auto`
    at the first and last row.
  - **A scroll REPOSITIONS it; it only closes when the icon leaves the panel.**
    Dismissing on scroll was the first attempt and was wrong twice over: a
    `scroll` event is delivered on the next frame, so the very scroll that
    brought a row into view arrived *after* the picker opened and shut it again
    — the picker could not be opened at all on a row you had just scrolled to.
    `tests/e2e/define-plane-mode.mjs` §19 pins this.
  - **Hover opens, a click makes it sticky**, and leaving closes it after a
    260ms grace — the pointer has to cross a few pixels of row to reach it.
    Esc and an outside mousedown close it too.
  - **The current state is shown, dimmed and `disabled`.** It is there to say
    what you have, not to be picked again.
  - **`setNodePin` is model logic, not widget logic** — it was the `<select>`'s
    change handler, and it keeps all three rules: Set Origin Mode refuses,
    `plane-locked` is refused for a node in no plane (where "stays in its
    planes" has no meaning) and nominates none for a node in any, and every
    plane standing on the node loses its stored fit, because a pin change
    changes what a fit is allowed to do. The status then names what holds the
    node — asked AFTER the change, so it answers with derived planes, the same
    answer every other reader of the pin gets. A plane the node is in that
    cannot yet say where it is is still NAMED, with the reason: "Plane-locked"
    alone would leave the user looking for a restriction the panel is not
    showing.
- **Typing a position** — `commitNodeXyz` /
  `applyTypedNodePoint` / `reprojectNodeIntoPlacedViews` / `fmtXyz` (all
  private). The expanded panel's three fields are the keyboard path to the same
  place the 3D drag reaches, and it follows the drag exactly: **the 2D follows
  the 3D**, so every view the node is placed on is rewritten to the exact
  reprojection of what was typed, the per-node errors are re-derived, and the
  stored `planeFit`s are left alone (a corner must not move the frame it
  defines). Four decisions worth knowing:
  - **Why they are in an expanded row.** The info panel is a fixed 300px; the
    row's own controls want ~120 of the ~282 it has to spend, and three legible
    number fields do not fit in what is left at any panel width the app
    currently has. They also do not belong on screen at rest: nine nodes of
    nine numbers was most of what made the old list unreadable.
  - **A field still showing what the panel printed keeps its FULL stored
    double.** The display is 4 decimals (`fmtXyz`), all three fields are read on
    every commit (a position is a triple), and re-parsing them all would round
    the two axes the user never touched — editing z would silently move x.
  - **Revert-on-invalid, except when there is nothing to revert to.** A node
    with no 3D is being ENTERED rather than edited, so the first two numbers
    typed stay put until the third arrives, with the status asking for them.
  - **`locked` is read-only and `plane-locked` is projected.** A Locked node's
    fields are `disabled` and its panel carries no commit listener at all (the
    guard in `commitNodeXyz` covers the pin changing under a live field); a
    Plane-locked one goes through `constrainPoint3dForNode`, the same model-side
    enforcement a solve's publish path uses, and the status names what it was
    moved to — a plane, the line two planes meet in, or the point three meet at
    — because a number that comes back different from the one typed needs
    explaining, and "Plane-locked" without the geometry does not explain it.
    `planeLockWhere` is the one place that sentence fragment is built, so the
    typed editor, the drag-end status, the padlock tooltip and the pin picker
    cannot describe the same restriction three different ways.
- `enterPlaneMode()` / `exitPlaneMode()` / `togglePlaneMode()` /
  `isPlaneModeActive()` — show/hide the `#planeModeBar` banner and swap the
  info panel's `.panel-tabs` + `.panel-tab-content` for `#planePanel`. The swap
  only toggles inline `display`, so the tab bar's scroll position and active
  tab are untouched and exiting restores exactly the previously-active tab. Exiting also
  clears the plane selection/hover, and unwinds both things entered from inside
  the mode that lock this panel: `exitOriginMode()` and `closeAngleModal()`.
- `handlePlaneDrop(planeId, viewName, clientX, clientY)` — the drop listener is
  a thin adapter over this. Converts the cursor position with
  `interactionManager.canvasToVideo`, so a drop lands where the pointer is under
  zoom / pan / rotation exactly like a click would.
- `planeInteractionCallbacks()` — the callback bag `ui/interaction.js` needs
  (`isPlaneEditMode`, `getPlaneInstances`, **`getPlaneNodeIndices`**,
  `getPlaneEdges`, `getPlaneNodeSize`, **`beginPlaneDrag`**,
  `isPlaneDataLocked`, `onPlaneChanged`, `onPlaneSelectionChanged`). Merged into the InteractionManager's callbacks in
  `pose/initialization.js` so that module keeps no import of the plane feature.
  Two of these carry the pool model into hit testing: `getPlaneNodeIndices`
  reports the indices actually SHOWN on a view (an instance covers the whole
  pool, so a node whose only plane is un-placed would otherwise be grabbable
  while drawing nothing), and `beginPlaneDrag` refuses a **pinned** node and
  restricts an Alt+drag to the grabbed plane's nodes (translating every point of
  the instance would drag unrelated planes along). It also refuses every node
  while the Set Angle dialog is open — the 2D half of that edit lock, with the
  reason in the status bar; the click still SELECTS, as with a pinned node.
  `isPlaneDataLocked` (`isAngleModalOpen`) closes that half's other two doors:
  the right-click null toggle, which reaches the model without passing through
  `beginPlaneDrag`, and — in `handlePlaneDrop` — dragging a plane row onto a
  view, which no `disabled` could stop because a `<tr>` does not take one.
- `onPlaneChanged(inst, movedIndices, {moved})` — a 2D edit invalidates the 3D of
  **the nodes that moved**, not the whole plane: a node's 3D is the node's, and
  clearing a neighbour's would throw away work the edit says nothing about.
  Pinned nodes are skipped (`invalidateNode3D`), but every plane standing on a
  moved node still loses its fit. When `moved` is true it also clears those
  nodes' `derived` flags — a point the user dragged is theirs, whatever put it
  there. Deliberately NOT done inside `setPoint`: the fit's 2D write-back and the
  3D corner drag go through the same setter and must not promote the model's own
  output to evidence.
- `drawPlaneOverlays(view)` — fills and edges per placed plane, then the NODES
  once each over the union of those planes (a shared corner is one node with one
  point, so drawing it twice would only double the anti-aliasing), then the
  plane name at each plane's own centroid. Called by `drawAllOverlays` **after**
  `drawFrameOverlays`. Three node states are visually distinct because they mean
  three different things to the next solve: **solid** = the user's annotation,
  counted; **hollow grey** = nulled, turned off; **ghosted with a dashed ring** =
  derived, reprojected into a view the user never annotated, so shown and
  draggable but not counted. Nulled wins when both apply. A **pinned** node gets
  an extra white ring on top, because finding out it will not move by dragging it
  would read as a broken drag rather than a deliberate lock.
- `refreshPlanePanel()` — rebuilds the panel: `renderEditor` (section header +
  empty state, plane name, the global Nodes table and its per-node coordinate
  rows, the frozen-node warning, the
  selected plane's members table, the add-an-existing-node dropdown, and the
  connection selects + table), then the planes table, action row, origin button
  and origin result, and finally `refreshMeshObjectsPanel()` from
  `ui/mesh-objects.js`. Full DOM rebuild per mutation, deliberately — no
  incremental diffing. It ends with the private `applyAngleModalLock()`, which
  disables every control in `#planePanel` while the Set Angle dialog is open
  (the panel half of that dialog's edit lock). LAST, so it overrides whatever
  the renders above decided, and re-asked on every render rather than remembered
  — a rebuild would otherwise leak an enabled button, and unlocking needs no
  bookkeeping because those renders have just recomputed each control's real
  state.
- `setupPlaneDefinition()` — one-time wiring. Called once from
  `pose/initialization.js`. Calls `setupMeshObjects()`.

**The 3D Mesh Objects table is NOT here.** It lives in `ui/mesh-objects.js`, and
this module's entire involvement is one import, the `setupMeshObjects()` call
above, the `refreshMeshObjectsPanel()` call above and the private
`syncMeshObject3D()`. That separation is deliberate: the objects feature is
strictly additive, and keeping it out of this file is what makes "nothing
existing changed" checkable rather than asserted.
- `PLANE_DRAG_MIME` — `'application/x-lucid-plane-skeleton'`.
- Re-exports `PlaneModel` / `PlaneSkeleton` / `PlaneInstance` / `PlaneNode` /
  `PlaneNodePool` / `seedPlanePoints` / `planePolygonOrder` /
  `points3dForPlane` / `nodeFreezeState` from `pose/plane-data.js`.

**Editing is gated on the mode.** `isPlaneModeActive()` backs the interaction
manager's `isPlaneEditMode` callback, so **outside** Defining Plane Mode a
plane draws but never takes a click — plane nodes can never compete with pose
nodes during normal annotation. Inside the mode planes take priority on
mousedown, and a MISS falls through to the normal handling, so pose editing
still works while the mode is on.

**One placement per view per plane.** A second drop of the same plane on the
same view is refused with a status warning rather than re-seeding, so carefully
positioned nodes can't be destroyed by a stray drag.

**The drag payload must never be `text/plain`.** `ui/sessions-panes.js` tells
dockview to `accept()` any drag over the dock whose types include `text/plain`
and to turn the drop into a **new video panel** named from the payload. A
plain-text plane payload would be swallowed there as a bogus view name instead
of placing a plane. Using a private MIME means dockview's
`onUnhandledDragOverEvent` never accepts, no droptarget overlay appears, and
this module's delegated listeners on `#videoDock` get the events.
`tests/e2e/define-plane-mode.mjs` guards both halves: it asserts `dragstart`
sets *only* the private MIME, and performs a real browser drag that must not
spawn a dockview panel.

**Imports from project modules.**
- `../pose/plane-data.js` — `PlaneModel`, `PlaneSkeleton`, `PlaneInstance`,
  `PlaneNode`, `PlaneNodePool`, `seedPlanePoints`, `planePolygonOrder`,
  `planeFillOrderPoolIndices`, `planeFillOrder3d`, `planeNodeIndices`,
  `planeNodeNames`,
  `planeNodeColors`, `planeEdgesLocal`, `planeEdgesPoolIndices`,
  `planeCentroid2d`, `points3dForPlane`, `writePoints3dForPlane`,
  `nodeErrorsForPlane`, `nodeFreezeState`.
- `../pose/pose-data.js` — `hasPoint3d`, `getPoint3d`.
- `./app-state.js` — `state`, `interactionManager`, `viewport3d`.
- `./origin-definition.js` — the Set Origin wizard. **Circular** (that module
  imports `planeState` / `planeModel` / `getPlane` / `planePoints3d` /
  `planeNodeNameAt` / `syncPlanes3D` back); call-time use only.
- `./overlays.js` — `makeVideoToCanvasTransform`.
- `./section-state.js` — `persistSectionStates` (every collapsible section in
  the panel except Danger Zone, under the `planeSectionsOpen` key).
- `./info-tip.js` — `setInfoTip` (the Pinned column's ⓘ, the Planes table's
  Views column and the ⓘ in each major section's `<summary>`:
  `PLANE_SECTION_INFO` / `wireSectionInfoButtons`).
- `./plane-visibility.js` — `planeVisibility`, read by `syncPlanes3D` to push
  `showPlaneSurfaces` / `showPlaneNodes` into the viewport. The same module
  backs the 2D half in `ui/plane-overlays.js`, which is what keeps the two
  representations agreeing about what "planes are off" means.
- `../import-export/save-load.js` — `setStatus`, `markDirty`.
- `./rendering.js` — `drawAllOverlays`, and `../pose/triangulation.js` —
  `triangulatePoints`, `reprojectPointCamera`, `fitPlaneToPoints3d`,
  `projectPoints3dOntoPlane`, `fitPlaneConstrained`,
  `projectPoints3dOntoPlaneConstrained`, `mergeFrozenPoints3d`,
  `summarizePlaneTriangulation`, `planesInvalidatedByFit`. Both **circular**
  (rendering imports `drawPlaneOverlays` from here, and triangulation imports
  rendering); safe because every use is inside a function body.

**The mode blocks the pose-annotation toolbar.**
`applyPlaneModeToolbarLock()` disables `+ Instance` / `- Instance` / `Group` /
`Edit Group` / `Triangulate` / `Triangulate All` / `Track Frame` / `Track All`
while the mode is on. All of them act on POSE annotation, which is a different
object than the plane geometry the mode is for: in the mode a click lands on a
plane node, the info panel is the plane panel, and `interactionManager`'s
selection is a plane — so pressing Group or Triangulate would operate on a pose
selection the user can no longer see or change, producing an edit they did not
mean and cannot observe. The VISIBILITY controls (User / Predictions /
Reprojections / Errors), Sessions, Tracks / Identity and the Panel toggle are deliberately NOT blocked: they
change what is DRAWN, not what is annotated, and turning Predictions off to see
the plane you are placing is exactly what the mode is for.

Three details it has to get right:
- **`disabled` alone is not enough for the two Triangulate buttons.** Each sits
  inside a `.tri-dropdown` whose menu opens on **hover** (CSS) and whose DLT /
  BA entries are `div`s with their own click handlers, so `disabled` on the
  button reaches neither. The wrappers get `.plane-mode-locked`
  (`pointer-events: none`), which kills the hover-open and the items together.
- **The lock is re-asserted from `drawAllOverlays`**, because that function
  rewrites `tbGroup.disabled` / `tbEditGroup.disabled` on every overlay draw.
- **Each button's prior `disabled` is snapshotted at lock time and restored on
  exit** — the rule `lockUI` in `ui/origin-definition.js` already follows, so a
  button disabled for its own reasons (Track All mid-run) does not come back
  enabled. The snapshot is taken only on the transition; re-taking it on the
  re-assert would record the LOCKED state and make the restore a no-op.

`styles.css` gained a `.toolbar-btn:disabled` rule at the same time — a disabled
toolbar button previously had no styling of its own, so it looked exactly like a
live one and only failed on click.

**Imported by.** `ui/rendering.js` (`drawPlaneOverlays`,
`applyPlaneModeToolbarLock`), `ui/ui-wiring.js`
(`togglePlaneMode`, for the View menu item), `pose/initialization.js`
(`setupPlaneDefinition`, `planeInteractionCallbacks`, `refreshPlanePanel` —
called next to `syncPlanes3D` in `setup3DViewport`, which is the one place a
freshly RESTORED plane model reaches the Nodes / Planes tables on every
project-load path), `ui/origin-definition.js`,
`import-export/plane-metadata.js` (`planeState`, at call time).

**DOM it owns.** `#planeModeBar` (+ `#planeModeExit`) under the toolbar, and
`#planePanel` inside `#infoPanel` — **three sibling `.info-section`s**, in this
order:
1. `#planeNodesDetails` — the POOL list `#planeNodesTable`
   (`.plane-nodes-table`), columns **(chevron) / Color / Name / Pinned /
   Delete**. The three icon columns are content-sized, so their labels set their
   width and Name takes what is left; `.th-center` centres a label and its
   control together. `Pinned`'s label carries `#planePinInfo`, the button
   explaining the three states. There is no membership column and no 3D column:
   the padlock says what the state badge used to, and the row carries the rest
   (its `title` is `nodeStateTitle`, and `plane-node-frozen-unsolved` draws an
   error stripe).

   A node's IDENTITY row is `.plane-node-main`: `.plane-node-expander` (with
   `.plane-caret`), `.plane-node-color`, `.plane-node-name`,
   `.plane-node-pin-btn[data-pin]` and `.plane-node-del`. **Select it with
   `tr.plane-node-main`, never `tbody tr`** — an expanded node adds a second
   row. That row, `.plane-node-detail`, appears only while the node is in
   `planeState.expandedNodes`, and holds one `colspan=5` cell ▸
   `.plane-node-detail-body` ▸ `.plane-node-xyz-line` (three
   `.plane-node-xyz-cell`: `.plane-node-xyz-label` +
   `.plane-node-xyz-input[data-axis]`) and `.plane-node-planes`
   (`.plane-node-plane-chip`, one per plane the node is in, with EVERY plane
   currently holding a plane-locked node marked `.plane-node-plane-holder` and
   carrying a `.plane-node-plane-mark`). Both rows carry
   `data-plane-node-id` and
   `.plane-node-row.plane-node-{mutable,frozen,frozen-unsolved}` plus
   `.plane-node-unused` / `.plane-node-shared`, so every state cue runs down the
   whole node; the open identity row also gets `.plane-node-open`. Both rows of
   the SELECTED node (`planeState.selectedNodeId`) carry
   `.plane-node-selected`, which tints the cells rather than adding a third
   left bar — `.plane-node-shared` and `.plane-node-frozen-unsolved` each claim
   the same 2px inset, and selection has to be legible on top of either.
   `data-plane-node-id` is also what makes an element SELECT its node: the
   capture-phase listener in `setupPlaneDefinition` reads it, so the per-node
   lines of a plane's triangulation readout (`.plane-tri-node`) select too. The picker is
   `#planePinPopover` (`.plane-pin-popover` ▸ `.plane-pin-option[data-pin]`,
   the current one `.is-current`), a child of `document.body` rather than of any
   row. With it: `#planeNodesEmpty`, the
   `#planeFrozenWarning` line, and `#planeNodeNameInput` + `#btnAddPlaneNode`
   (pool-only: it creates no plane and joins none).
2. `#planePlanesDetails` — **Planes**. Summary =
   `.plane-summary-label` ("Planes") + `#planeEditorTitle` (the SELECTED
   plane's name) + `#planePlanesInfo`. The body, in order:
   `#planeSkeletonsTable` (the **Planes** table, drag
   source and the only selector; `data-plane-skeleton-id`, `.plane-expander` /
   `.plane-placed-count`,
   `.plane-placements-row` ▸ `.plane-placements-body` ▸ `.plane-placement-item`
   / `.plane-tri-summary` / `.plane-tri-node` ▸ `.plane-tri-node-name` /
   `-xyz` / `-err` / `-pin`, each node line also carrying
   `data-plane-node-id`), `#planeSkeletonsEmpty`, then
   `.panel-button-row.plane-create-row` ▸ `#btnNewPlaneSkeleton`
   (`+ New Plane`), then `#planeEditorEmpty` and `#planeEditorContent` — the
   latter swapped for the former when nothing is selected. Inside
   `#planeEditorContent`: `#planeSkeletonName` (the editable name),
   `#planeMembersDetails` (the members
   table `#planeMembersTable`, columns **Name / Color swatch / ×**, rows
   carrying `data-plane-member-id` and `.plane-member-name` /
   `.plane-member-swatch`; `#planeMembersEmpty`; `#planeAddNodeSelect` +
   `#btnAddExistingPlaneNode` + `#planeAddNodeHint`), `#planeEdgesDetails`
   (`#planeEdgesTable`, `#planeEdgesEmpty`, `#planeEdgeSrcSelect` /
   `#planeEdgeDstSelect` / `#btnAddPlaneEdge`) and `#planeActionsDetails`
   (**Actions**: the `.plane-action-row` ▸ `#btnPlaneTriangulate` /
   `#btnPlaneFill` / `#btnPlaneFit`, then `#btnSetOrigin`, then
   `#btnSetPlaneAngle`). Last in the body and OUTSIDE
   `#planeEditorContent`: `#planeAppearanceDetails` (**Plane Appearance**:
   `#planeNodeSize` / `#planeEdgeWeight` / `#planeNodeSize3d`). Appearance is a
   SUB-section rather than a section of its own because it styles exactly what
   the roster lists and nothing else in the panel, and it is outside the
   swapped body because that is the part that needs a selected plane; it stays
   `open` so the sliders are no less discoverable than when they sat at the top
   level.

It also creates
the modal `#planeDialog` (`.plane-confirm-overlay` / `.plane-confirm-modal`,
`#planeDialogMessage`, `#btnPlaneDialogCancel` / `#btnPlaneDialogConfirm` /
`#btnPlaneDialogDismiss`) for blocking errors and confirmations — **Esc closes
it, and Esc CANCELS**, per the project's modal rule. Styles live under the
"Defining Plane Mode" block at the end of `styles.css`.

**Section titles are 14px** (`.plane-details > summary`). The sub-sections —
Nodes In This Plane, Node Connections, Actions and Plane Appearance, all four
inside Planes — stay at 12px via
`.plane-subdetails`, which is what makes the hierarchy legible without indenting
them.
`tests/e2e/define-plane-mode.mjs` §2 asserts both sizes, so a section added with
the wrong wrapper is caught rather than merely looking odd.

**The pin states are named for the padlock.** `PIN_LABELS` reads
**Unlocked / Plane-locked / Locked** — it said "Free" while the control was a
`<select>`, and the three names now have to be the three things a padlock can
be. The model values (`'none'`, `'plane-locked'`, `'locked'`) did not change,
and neither did anything on disk.

**Icons are inlined SVG strings** (`ICON_PIN`, `ICON_INFO`, and the older
`ICON_TRIANGULATE` / `ICON_MESH` / `ICON_FIT`) — no build step and no asset
requests: an `<img>` per row would be three more round trips and a flash of
nothing on first paint, and `currentColor` is what lets one padlock take the
state's colour. The three padlocks were traced from supplied Lucide-style SVGs
whose files landed in the gitignored `prompts/` scratch folder, so **the
geometry in `ICON_PIN` is the only surviving copy** — edit it there, not from a
file. The C2PA provenance blob those exports carried (8KB of base64 each) is
dropped.

**The panel's width belongs to the tables.** `#infoPanel` is a fixed 300px, so
the coordinate fields were paid for by the boxes around them: `.plane-panel`,
the `.info-section` wrapper (which had been inheriting the 14/16 padding meant
for the tabbed info panel), `.plane-details-body` and the cell padding were all
trimmed, and the generic `.data-table` 120px cell cap is lifted inside the plane
panel — it exists to ellipsize read-only text and would have clipped a row of
inputs. (The Planes table takes the opposite tack for the same reason; see
**It FITS the 300px panel** below.)
The sections stay `<details>`: folding one away is how room is made
VERTICALLY, which is the axis that is cheap here. Those rows also stop
pretending to be clickable (no hover highlight, default cursor) — they are
forms, nothing happens when you click one, and a hover that lit up half a node
was advertising an interaction that does not exist.

**`frozen-unsolved` is said in the open.** A node pinned before it was ever
triangulated can never acquire a 3D — the pin is exactly what forbids a solve
from writing one — and it blocks every fit of every plane it belongs to
(`no_anchor_3d`). So it gets its own badge colour in the Nodes table AND a
`#planeFrozenWarning` line naming the nodes, not just a tooltip: a tooltip is
not read by someone who does not already suspect a problem.

**Three shared appearance values, not two.** `planeState.nodeSize` (2D, canvas
px) and `planeState.nodeSize3d` (3D scene units) are separate because they are
in unrelated units — one is sized against the video, the other against the
world — and `nodeSize3d` is separate from the viewport's own
`skeletonNodeSize` so sizing plane corners never resizes pose nodes.
`wirePlaneSlider` takes an optional `apply` callback for exactly this: the 3D
slider re-pushes the scene (`syncPlanes3D`) instead of redrawing the canvases.

**The Planes table.** Columns are expander / Name / Nodes / **Views** / delete.
The only per-row action is delete. Expanding a row reveals that plane's
placements inline — one line per view, click to
select, × to un-place — plus the triangulation, pinned-anchor and plane-fit
readouts when there are any. There is no separate Placements table. The row is
the drag handle, so the expander and action cells suspend `tr.draggable` on
`mouseenter` — otherwise a button press starts a drag.

**Views is `annotated / total`, and ANNOTATED is not PLACED.**
`annotatedViewStats` counts the views where at least one of the plane's corners
is hand-placed — present, not switched off, not reprojected — over every view
in the session. The distinction is the reason the column is worth having:
`Triangulate` reprojects a plane into the views it was never placed on, so
afterwards it IS placed everywhere while the user may have drawn it twice.
Those corners are the solve's own output and are excluded from the next solve as
evidence, so counting them would make the fraction read full after one
Triangulate and never say anything again. It uses the SAME test
`triangulatePlane` applies to pick contributing views (`usableViews` there), so
the number and the solver cannot disagree about what counts. A shared node
hand-placed for a neighbouring plane counts for this one too — one node is one
2D point per view, so the evidence really is there for both. With no calibration
loaded the cell is a dash, not `0/0`.

The column's ⓘ (`planeViewsInfo`, in `PLANE_SECTION_INFO`) is **one short
sentence** — "The fraction of number of hand-annotated views out of all views."
— and every tip in this panel is held to that. A tip long enough to need
reading is a tip nobody reads, and it covers the pointer while it is up. The
reprojected-corners caveat therefore lives on the CELL's own `title`, beside the
number it qualifies, rather than in the header's tip.
`tests/e2e/plane-views-column.mjs` §5 asserts the tip stays under 120 characters
and one sentence, so it cannot silently grow back into a paragraph.

**Three unlabelled marks were removed to make room for it**, and the row is
better for having one legible number instead of three illegible ones:
- **`+n` shared nodes**, on the Nodes cell. It meant "of which n are shared",
  but `+` reads as an ADDITION: `4 +4` on a plane with four corners looked like
  nine. The count stays in the cell's `title`, where it can use words.
- **The `3D` badge**, shown once a plane was solved. Two letters in a box, in a
  column with no header. Whether a plane has 3D is answerable from the viewport,
  the node coordinates and the triangulation readout in the expanded row.
- **The placed-view count** beside the caret. It was a THIRD view number on the
  row, one column from the Views fraction, measuring something different
  (placed, not annotated) with nothing saying so. The expander is now a bare
  caret; the placements themselves are still listed when the row is expanded.

**It FITS the 300px panel, and two separate things had to give for that.** The
section used to scroll horizontally and clip the right-hand end of every line
in an expanded row (panel `scrollWidth` 401 against `clientWidth` 300):
- **The table grew.** An auto-layout table is sized by its widest cell and
  simply ignores `width: 100%`, so `#planeSkeletonsTable` (and, for the same
  reason, `#planeMembersTable` / `#planeEdgesTable`) is `table-layout: fixed`
  with the `<th>` widths binding — 20 / auto / 46 / 62 / 28 px here. The 62 is
  measured, not guessed: "VIEWS" is 37px at the header's 10px/0.5px uppercase,
  plus the 16px ⓘ and its 3px margin, plus 6px of cell padding. Below that the
  header silently becomes "VIEWS…", which `tests/e2e/plane-views-column.mjs`
  §6 catches by comparing each header's `scrollWidth` to its `clientWidth`. The cells'
  inherited ellipsis is what gives instead, so a long plane name truncates and
  repeats itself in `tdName.title` (which also carries the row's drag hint,
  because a cell `title` wins over the row's). `#planeNodesTable` is
  deliberately NOT fixed: its rows are input fields that size themselves.
- **`white-space: nowrap` leaked into the sub-row.** `.data-table tbody td`
  sets it, and it inherits into every div `buildPlacementsRow` puts in the
  cell, so the three summary sentences could not wrap. They now live inside
  `.plane-placements-body`, which undoes it — and which also gives the sub-row
  the `margin-left: 22px` + left rule that an expanded NODE already had, so the
  two sections read as one widget.
`.plane-tri-node` went from one nowrap string to a **wrapping flex row** of
parts (`.plane-tri-node-name` / `-xyz` / `-err` / `-pin`): at 246px of usable
width a long name plus a coordinate triple plus a residual does not fit on one
line, and wrapping keeps all of it on screen where truncating would not. Only
the name ever ellipses, and the whole line is repeated in the row's `title`.
The trailing word **"pinned" became the `ICON_PIN.locked` padlock** — the same
one the Nodes list uses — which buys back a third of a coordinate's width; the
word survives in that tooltip. Nothing else was shortened: coordinates are
still 1 decimal and residuals 2. Pinned by `define-plane-mode.mjs` §18b, which
builds a worst-case row (long plane name, long node names, four view names,
four-digit coordinates, a constrained fit, two pins) and asserts
`scrollWidth <= clientWidth` on the panel, the table, the section and the
expanded cell, plus that no descendant's right edge passes the panel's.

**The shared action row** (`#btnPlaneTriangulate` / `#btnPlaneFill` /
`#btnPlaneFit`, below the table) acts on the **selected** plane and is disabled
outright when nothing is selected. When something IS selected the buttons stay
enabled even if the action's precondition fails — clicking then reports WHY in
the status bar, which teaches more than a dead button. `renderActionRow()` owns
their enabled/active state and titles.

**`#btnSetOrigin`** sits below that row and hands off to
`ui/origin-definition.js`. It is gated on there being a FITTED plane anywhere —
not on the panel selection — because the wizard picks its corner in the 3D
scene from any fitted plane; gating it on the selection would disable it for a
perfectly valid project. `renderOriginButton()` owns that.

**`#btnSetPlaneAngle`** sits below THAT and hands off to `ui/plane-angle.js`,
gated the same way but on **two** planes and on a USABLE fit rather than a
stored one (`anglePlanes()` — see that module), since an angle is a relationship
and a plane that has been triangulated has a plane whether or not anyone pressed
Fit. `renderAngleButton()` (imported, and called from `refreshPlanePanel`) owns
it.

**Triangulate says which nodes it could not move.** `showLockedNodesDialog`
raises a modal naming a plane's `locked` nodes whenever `Triangulate` skipped
any, and `triangulatePlane` refuses outright (with `lockedNodeNames` on the
result) when EVERY node is locked, rather than reporting a success that moved
nothing. The skip itself is old, correct behaviour — `setPoint3d` refusing a
locked write is the entire locking mechanism — what changed is the REPORTING:
it used to be a parenthetical inside a green success line ("… (2 pinned,
kept)"), which reads as a detail rather than as "the thing you asked for did
not happen to these corners". That matters far more now that
**Set Angle Between Two Planes locks nodes automatically**, so a user can
arrive holding locks they never set by hand. **`Fit` deliberately does NOT get
this dialog:** holding pinned nodes fixed is what a CONSTRAINED FIT is *for* —
the plane is solved to pass exactly through them, so they are honoured rather
than skipped, and `reportFit` already says how many were held. A modal there
would nag about the feature working as designed.

`showPlaneDialog` and `refreshTriangulationErrors` are exported (rather than
module-private) so `ui/plane-angle.js` can reuse the one error-modal idiom and
the error re-derivation instead of growing a second copy of either.

**A major section explains itself in an ⓘ, not a paragraph.** Nodes, Node
Connections, Planes and 3D Mesh Objects each used to END in a `.plane-hint`
block of prose. In a ~300px column that is a wall of text permanently wedged
between one table and the next, read once and then scenery — and it sat at the
FOOT of the section, answering "what is this?" after the user had scrolled past
whatever they were unsure about. `PLANE_SECTION_INFO` maps each section's ⓘ to
its sentence and `wireSectionInfoButtons` installs them ONCE from
`setupPlaneDefinition` (not from `refreshPlanePanel`: these buttons are in the
static markup and their text never changes; `renderPinInfoButton` is the
exception only because its icon lives in a table header the panel rebuilds).
Two sections deliberately have NEITHER a paragraph nor an ⓘ: the Danger Zone,
whose warning belongs in the confirmation dialogs that actually fire, and Edit
Plane's "+ Add", where a working picker explains itself and only its two
EMPTY-STATE lines — real dead ends — survive.

**Tests.** `tests/e2e/define-plane-mode.mjs`, `tests/e2e/plane-mode-toolbar-lock.mjs`
(the toolbar lock: the redraw race, the dropdown hole, the visibility
carve-out and the restore-on-exit rule), `tests/e2e/plane-persistence-roundtrip.mjs`
(the dirty flag, driven through the real panel handlers),
`tests/e2e/plane-angle.mjs` (the locked-node dialog, and that unlocking hands
the corners back to the solver) and `tests/e2e/plane-section-info.mjs` (the four
ⓘ, that the paragraphs are gone, and that clicking an ⓘ does not fold its
section while the heading beside it still does).

---

### ui/origin-definition.js

**Purpose.** "Set Origin Mode" — the wizard that collects the two inputs
`pose/origin-frame.js` needs, applies the result, and reports it.

**The wizard.** Three steps, because both inputs are picked in the 3D scene and
each must be committed before the next is meaningful:

| step | action | result |
|---|---|---|
| `node` | click **any node** of a **fitted** plane | the new origin |
| `axis` | click the red (+n) or blue (−n) arrow | the new +Z |
| `confirm` | Cancel (back to `node`) / Continue | applies |

**ANY node of the plane, not just one on its outline.** A plane is a group of
nodes and its fit is a surface through all of them, so a node in the MIDDLE of
the floor is as good an origin as one at its edge — and on a real cage it is
usually the better one, since that is where a physical mark tends to be. The
picker never asked for an outline node: `_handleOriginPick` collects one mesh
per `plane.nodeIds` entry, so "is this a corner?" is not a question the viewport
can even ask. Only the wizard's own copy said otherwise ("Click a corner of a
fitted plane"), which is a restriction a user would reasonably believe and act
on — hence `tests/e2e/origin-picks-any-node.mjs`, which pins the copy AND drives
a click onto a node strictly inside a five-node quad.

**Only fitted planes offer nodes, and FITTED here means the user clicked
Fit.** Enforced in the viewport via `userData.planeFitted` — fed by the
payload's own `fitted` flag, independent of both `planeEditable` (dragging is
OFF during the wizard, but those same nodes stay pickable) and the payload's
`planeFit`, which is a *usable* fit and may be derived. That separation is
deliberate: a derived surface is enough to slide a corner along, but picking the
origin is a declaration about the project's frame, and a plane nobody has Fit
must not become eligible for it by accident. `fittedPlanes()` counts stored fits
only, and entering the mode is refused when nothing is fitted — so the button,
the picker and this list all agree.

**Both candidate arrows are always drawn.** The choice is between a normal and
its negation; showing one would hide that there IS a choice. Choosing dims the
loser rather than removing it, and the axis picker stays armed through
`confirm`, so switching is one click and needs no cancel.

**Key exports.** `originState`, `enterOriginMode` / `exitOriginMode` /
`isOriginModeActive`, `fittedPlanes()`, `pickOriginNode(planeId, nodeIdx)` /
`pickOriginAxis('positive'|'negative')`, `cancelOriginPick` / `applyOrigin` /
`clearOrigin` / `confirmClearOrigin`, `exportUpdatedCalibration()`,
`renderWizard` / `renderOriginResult`, `setupOriginDefinition`,
`attachOriginCallbacks(vp)`.

**The UI lock.** `lockUI` walks the menu bar, toolbar, info panel, viewport and
timeline and records each button's **prior** `disabled` state, restoring it
exactly on exit — blanket-enabling would bring back buttons that were disabled
for their own reasons (the plane action row with nothing selected). Esc, the
mode's Exit button and the wizard's Cancel/Continue are the exceptions and the
only way out. The menu bar's dropdowns are `div`s, so `disabled` cannot reach
them: `body.origin-mode-lock` blocks them in CSS instead. `exitPlaneMode`
unwinds this mode first, or leaving would strand every button disabled.

**Applying an origin does not move any data.** `viewport3d.setOriginFrame` moves
the displayed grid + axes — and the ORBIT with them, so dragging and zooming
re-center on the new origin (`_rebaseControls`, see `ui/viewport3d.js`); cameras,
skeletons and planes stay in calibration world coordinates. Re-baking them would silently change every 3D number the rest
of the app reads and reports — and the transform, not a rewritten point cloud,
is the deliverable.

The frame **is** persisted: `import-export/plane-metadata.js` writes it as its
two INPUTS — the origin and the chosen +Z — and `pose/origin-frame.js` rebuilds
`R`, the translation and the axis-angle form deterministically on load, so the
derived quantities can never contradict the inputs. Applying or clearing an
origin therefore calls `markDirty()`; entering and leaving the mode does not, as
a wizard the user backed out of changed nothing.

**Arrow length is scaled to the PLANE** (`arrowLengthFor`: 70% of the plane's
reach from the picked node), not to the camera baseline — a fixed length is
invisible on a room-sized plane and off-screen on a small one.

**`fittedPlanes()` asks the POINTS, not the plane.** A plane keeps its
`planeFit` until something clears it, but its corners' 3D can be invalidated
independently (they live on the nodes), so the filter requires at least one
node with a 3D position — otherwise the wizard would dead-end on a corner that
no longer exists. `pickOriginNode`'s `nodeIdx` is an index into the PLANE's own
node order (what the 3D payload was laid out in), not a pool index; the two
differ as soon as a node is shared.

**Imports from project modules.** `./app-state.js` (`state`, `viewport3d`),
`../import-export/save-load.js` (`setStatus`, `markDirty`),
`../pose/origin-frame.js` (`buildOriginFrame`, `rebaseExtrinsics`),
`../pose/pose-data.js` (`getPoint3d`, `hasPoint3d`, `Camera`),
`../import-export/file-io.js` (`exportCalibrationTOML`, `downloadTOML`), and
**circularly** `./plane-definition.js` (`planeState`, `planeModel`, `getPlane`,
`planePoints3d`, `planeNodeNameAt`, `syncPlanes3D`, `showPlaneDialog`) and
`./origin-rebase.js` (`showSetCalibrationModal` — this module owns the button,
that one owns what it does) — call-time use only, same rule as the other cycles
in this directory. Plane 3D lives on the shared
node pool now, so this module reads it through `planePoints3d(plane)` (a
plane-ordered materialization) and node names through `planeNodeNameAt`,
never off the plane object.

**Imported by.** `ui/plane-definition.js`, `ui/origin-rebase.js`,
`import-export/plane-metadata.js` (`originState`, at call time).

**DOM it owns.** `#originModeBar` (+ `#originModeExit`), the
`#originInstruction` overlay inside `.viewport3d-container`
(`#originDragHandle`, `#originStepText`, `#originLegend`, `#originConfirmRow`
with `#btnOriginCancel` / `#btnOriginContinue`), and, in the plane panel,
`#originResultSection` / `#originResultDetails` / `#originResult` plus
`#originDangerSection` / `#originDangerDetails` (`#btnExportCalibration`,
`#btnSetCalibration`, `#btnClearOrigin`). The overlay is `pointer-events: none`
except for its button row and its drag grip, so it can never steal a pick from
the canvas below.

**The overlay is draggable** (`setupInstructionDrag` / `placeBox` /
`applyBoxPosition`), because it floats over the very corner or arrow the wizard
is asking the user to click. Only the grip (`#originDragHandle`) takes pointer
events — making the whole box draggable would have meant giving it
`pointer-events: auto` and swallowing picks across its full footprint. The
position is page-session state (module-level `boxPos`, container-relative px,
not persisted) and is re-clamped every time the box is shown, since the 3D
viewport is resizable and a spot that was inside it can stop being so while the
box is hidden. Placing it explicitly also clears the stylesheet's centring
`translateX(-50%)`, which would otherwise offset the box from the cursor.

**Two collapsible blocks, not one section.** The readout lives in
`#originResultDetails` ("Defined Origin", **open** by default — it is what the
user just asked for) and the three actions that reach OUTSIDE the 3D view live
below it in `#originDangerDetails` ("Danger Zone", **collapsed** by default).
Both appear and disappear together with `originState.frame`, because all three
actions are relative to a defined origin: without one, export and Set would
write the calibration back out unchanged and Reset has nothing to reset.
Collapsing the readout matters because it is a dozen labelled vectors plus a
3×3 in a ~300px column, permanently in the way of everything below it.

- **`Export New Calibration`** → `exportUpdatedCalibration()`, which downloads
  `calibration-rebased.toml` (`REBASED_CALIBRATION_NAME` from
  `loading/calibration-pick.js`, shared with `ui/origin-rebase.js` — the two
  produce byte-identical TOML for a given origin): every camera's extrinsics through
  `rebaseExtrinsics`, written with the existing `exportCalibrationTOML` /
  `downloadTOML`. This is the other half of the deliverable — applying an origin
  deliberately moves no annotated point, which is only coherent if whoever
  consumes that 3D also gets a calibration that agrees on where the world is.
  Intrinsics, distortion, size and camera ORDER ride through untouched, so a
  diff against the original shows the origin change and nothing else; and the
  rotation keeps the NOTATION it arrived in (a 3×3 for an anipose-style
  calibration, a Rodrigues triple otherwise), since silently changing
  representation would make the file stop matching its siblings in a rig's
  config directory. It returns the TOML string, which is what the e2e asserts on.
- **`Set as New Calibration`** → `ui/origin-rebase.js`, which overwrites
  `calibration.toml` AND re-bases every 3D number in the project so the world
  becomes the defined origin. The committing twin of Export; see that module's
  entry for the ordering that makes a cancel safe.
- **`Reset to Calibration Origin`** moved here from the readout and now goes
  through `confirmClearOrigin`, which raises `showPlaneDialog` first. `clearOrigin`
  itself stays unguarded — the load path (`plane-metadata.js`) and the tests must
  reach it without a dialog, and the confirmation is about an unrecoverable
  CLICK, not about the operation. Unrecoverable literally: the frame is derived
  from a node and an arrow picked in the 3D view and nothing records which, so
  "undo" means walking the wizard again and hoping for the same corner.

**The Defined Origin readout is stacked, not tabular** (`renderOriginResult` →
`vectorBlock` → `namedBlock`; the old `vectorTable` is gone). Each of the seven
vectors is a `.origin-block`: its NAME on one line — with the unit (`mm`/`rad`)
as a muted `.origin-unit` span beside it — and its x/y/z on a
`.origin-block-body` line **indented** underneath, and the 3×3 `R` gets the same
shape with its caption as the name. The panel is ~300px and the previous
five-column table (`name | x | y | z | unit`) was wider than that, so the unit
column was clipped off the right edge; stacking is what buys the width back.
The layout classes are the Nodes list's own `.plane-node-xyz-line` /
`-cell` / `-label`, deliberately shared so the two readouts in the one panel
line up — **a coupling to keep in mind when those rules change.** What is NOT
shared: the value is a `.origin-xyz-value` span, not `.plane-node-xyz-input`,
because these are computed outputs and a box that looks typeable would lie; and
nothing here expands or collapses, since it is seven fixed vectors rather than a
list that grows with the project. Precision is unchanged at 3 decimals
throughout — it already fits.

**Tests.** `tests/e2e/define-plane-mode.mjs` §14 — which covers both blocks
(the readout collapses to its summary; the Danger Zone appears with the frame,
ships collapsed, and holds the three actions stacked and un-truncated), the
export (the emitted TOML is round-tripped back through `parseCalibrationTOML`
and a probe point must land on the same camera coordinates as it did under the
ORIGINAL calibration in the OLD frame, with a negative control showing the
unrewritten file does not), and the Reset warning (opening it, Esc and Cancel
all keep the frame; only Confirm clears). It also measures
`#originResult`'s `scrollWidth` vs `clientWidth` (and its widest descendant, and
the whole `.plane-panel`) **twice**: once on the fixture and once after
restaging the frame with six-figure mm coordinates and a long corner name — the
fixture's two-figure numbers fit even the old table, so only the wide case
actually pins the overflow fix. `tests/e2e/_diag-origin-panel.mjs` (untracked,
`_diag-` = not part of any suite) screenshots both blocks — the readout to
`$OUT` and the (force-opened) Danger Zone to `$OUT-danger.png`, separately,
because the panel's own scroll clips the second out of the first's frame;
`WIDE=1` stages the same wide-coordinate case.

---

### ui/origin-rebase.js

**Purpose.** The dialogs, the progress bar, the Cancel button and the file write
for **`Set as New Calibration`** — the committing twin of `Export New
Calibration`. The maths and the plan are `pose/origin-rebase.js`'s.

**The order of operations is not arbitrary.**

1. Confirm, with the inventory (`countRebaseTargets`).
2. **Get the file handle, still inside the click.** `showSaveFilePicker` needs
   transient user activation and activation expires in a few seconds, so asking
   for it *after* a minute of re-basing throws `SecurityError`. It has to come
   first even though it reads oddly.
3. Plan — the slow part — behind a blocking progress modal with Cancel.
4. Write the file.
5. Only then swap the buffers in.

Every failure mode therefore leaves the project untouched: a cancel drops the
plan, and so does a failed write. Step 5 is the one irreversible moment and it
is synchronous, so it cannot fail part-way.

**The calibration file is never overwritten.** The re-based calibration goes to
a NEW file, `calibration-rebased.toml` (`REBASED_CALIBRATION_NAME`) — not over
the `calibration.toml` the project was annotated against, which is usually
shared with tools outside LUCID. `Export New Calibration` writes the SAME name,
because for a given origin the two produce byte-identical TOML. Stated once, up
front, in `#originRebaseStaleWarning`: the new file takes PRECEDENCE over
`calibration.toml` when a folder holds both, which is exactly what
`pickCalibrationFile` does. That warning used to also claim a folder `.toml`
beats the calibration embedded in the `.slp` — true of
`handleLoadSessionFolderSingleSlp` (which reads the embedded copy only when the
folder has no `.toml`) but NOT of reopening the `project.slp`, which never
scans a folder, so the unconditional claim overstated it.

**The project IS saved, automatically.** `autoSaveAfterRebase` runs `quickSave`
as the commit's last step, so `project.slp` stops disagreeing with the
calibration written beside it. It saves ONLY when `state.slpFileHandle` already
exists: `quickSave` would otherwise open `showSaveFilePicker`, which needs
transient user activation the Continue click no longer has, and that case gets a
status asking for Save As instead. Success is read from the DIRTY FLAG
(`!state.isDirty`), not from the absence of an exception, because `quickSave`
reports its own failures without re-raising. It runs before the summary status
line, or `quickSave`'s own status text would overwrite the counts.

**There is no completion modal** (`showRebaseDoneModal`, `#originRebaseDone`
and `#originRebaseTodo` are gone). It listed two obligations: the save now
happens by itself, and the calibration warning had already been given in the
confirmation, so all it added was a dialog between the user and their re-based
project.

**A multi-session commit leaves a THIRD consequence, stated in the
confirmation.** There is one calibration file per session FOLDER and this action
writes exactly one of them, so the folders that were not written still hold a
calibration in the old frame, and the next folder load then splits the project
across two frames. `#originRebaseMultiNote` (when `t.sessions > 1`) names the
count and ends with the one thing left to do — *Ensure other re-based sessions
have an updated calibration file in their folders.* It deliberately does NOT
explain the old-frame/new-frame consequence or promise a load-time note: the
actionable instruction is what the user can use, and
`ui/calibration-notice.js`'s modal still reports the divergence if they do
nothing. Saying it in the confirmation rather than afterwards also puts it
where the user can still decline. Its first clause follows the SELECTION below
(`All 2 loaded sessions are re-based…` vs `1 of 2 loaded sessions are
re-based…`), because it is the one sentence a user checks their intent
against. The folder count is `picked - 1`, NOT `total - 1`: the folders it
names are the RE-BASED sessions other than the current one, whose
`calibration.toml` no longer matches their 3D — a DESELECTED session kept its
old 3D and its old calibration, which still agree, so counting it would send
the user to update a folder that is already consistent. With every session
selected the two are the same number. When `picked === 1` the trailing clauses
are omitted entirely: there are no other re-based folders, and an instruction
about sessions that do not exist reads as a defect in the dialog. Pinned by
`tests/e2e/set-new-calibration.mjs` §6/§7/§8.

**On a multi-session project the user CHOOSES which sessions move.** Re-basing
all of them unconditionally was a decision the dialog was making on the user's
behalf, so `#originRebaseBySession` carries a checkbox per row
(`.origin-rebase-session-toggle`, `data-session-index`) and the Continue click
hands `runSetCalibration` the FILTERED array — no mode flag, so there is no
partial code path to drift. Four things about it:
- **The ACTIVE session's toggle is checked and DISABLED.** Its cameras are what
  `calibration-rebased.toml` describes, and the project-wide `PlaneModel` — the
  node pool and every plane fit — moves once, with it; leaving it behind would
  write a calibration for a frame the project's own plane geometry is not in.
  It is found by `sessions.indexOf(state.session)`, NOT by
  `state.activeSessionIdx` and not by assuming 0: `state.session` is what
  `runSetCalibration` reads to choose the cameras for the file, so pinning the
  row by anything else could let the pinned row and the written calibration name
  different sessions.
- **Every headline number follows the selection**, through
  `subsetRebaseTally` — a re-FOLD of `tFull.perSession`, not a re-count, so a
  click does not re-walk a lazy project's columnar store. One `renderSelection()`
  owns all four selection-dependent strings (both tables, the block note, the
  hazard warning, the multi-session note) and is called at build time too, so no
  initial string can drift from it. `plane nodes` / `Plane fits` deliberately do
  NOT move with the selection: one project-scoped `PlaneModel`, moving once.
- **Deselecting is a real hazard and `#originRebaseSubsetWarning` says so**,
  in two sentences and ONLY while something is switched off: the sessions left
  behind keep their old 3D while the rest of the project moves, so the project
  holds 3D in two coordinate frames — exactly what
  `pose/calibration-compare.js` detects and `ui/calibration-notice.js` reports
  on the next load. It sits under the checkboxes rather than with the two
  cautions, because it is feedback on the control that causes it.
- **`runSetCalibration` force-includes `state.session`** if the caller left it
  out. Unreachable from the UI, but without it `exportCalibrationTOML` would be
  handed zero cameras and write a valid, EMPTY calibration — silently, and
  after the 3D had already moved.

**Write access.** `Load Calibration` goes through a plain `<input type=file>`,
which hands back bytes and no write handle, and a session-folder load gives no
handles at all — so there is nothing to inherit and the user points at the file
once per page session (`calibHandle`, not persisted; `resetCalibrationHandle()`
is the test seam). Without the File System Access API it degrades to a plain
download. With more than one session loaded, the CHOSEN sessions are re-based
(see below) but only the ACTIVE session's cameras go into the file, and the
dialog says so.

**Blocking means blocking.** The progress modal's scrim stops the pointer and a
capture-phase `keydown` swallower stops the app's shortcuts, which are bound on
`document` and would otherwise happily scrub the timeline or start a
triangulation on top of a re-base. Esc is passed through as Cancel, per the
project's modal rule.

**The inventory is TWO tables, and which table a row is in is the claim being
made about it.** `#originRebaseCounts` is *Origin-dependent — updated* (3D
points to update, split into pose keypoints and plane nodes; plane fits; camera
**extrinsics**); `#originRebaseKeeps` is *Not origin-dependent — unchanged*
(2D user/predicted instances, reprojections, plane placements, camera
**intrinsics + distortion**, image size and camera order). A camera appears in
both on purpose: its extrinsics move and its lens model does not, and "does
this rewrite my intrinsics?" is the most common fear about pressing the button.
The first title says *updated* rather than *rewritten*: these numbers are
re-expressed in a new frame, which is not the same threat as being overwritten,
and half this dialog's job is saying what is NOT overwritten.

**Those two blocks FOLD; the per-session one does not.** `buildTable`'s fifth
argument, `collapsible`, builds the block as a real `<details open>` whose
`<summary>` is the title (styled by `summary.origin-rebase-block-title` in
`styles.css` — the browser's marker suppressed and one rotated caret drawn in
both states), so the keyboard, the accessibility tree and the `open` attribute
come from the browser instead of a hand-rolled click handler on a `div`. The
note and the table both sit INSIDE, so folding hides a section's whole body
rather than leaving an orphaned sentence. The **state is deliberately not
persisted** — no `persistSectionState`, nothing in `localStorage`: that helper
is for display taste in a long-lived panel, while the two-table split is the
claim this dialog asks the user to trust, so a fold made once must never be how
the next re-base is confirmed. Every open rebuilds them expanded.
`#originRebaseBySession` stays a plain `div` because it holds the per-session
checkboxes, and folding away the control the user came to use is worse than an
uneven stack. Still ONE scroller — the `<details>` add no `overflow`, and
folding both shortens the modal's contents (983 → 605 px on the multi-session
fixture) with Continue reachable in either state. `buildTable` returns
`{ table, note, block }`.

**Every row is present for every project, zeros included.** A per-camera
session with no `project.slp` has no instance groups and no pose 3D, so those
rows read 0 — which is how a reader tells an un-triangulated session from a
triangulated one. Hiding them would make the modal's shape depend on the load
path and turn "there is no 3D here" into silence, which is the failure this
dialog already had once.

**`#originRebaseBySession` appears only when `sessions > 1`.** A multi-session
project loads each folder independently, so it can carry a different
`calibration.toml` per session — and only the ACTIVE one's calibration is
written out. Each row is a checkbox + the session name, then
`N 3D · M cam · K 2D`. It is its own block rather than sub-rows of the totals:
those already decompose by provenance and sum exactly to their headline, and a
second, orthogonal decomposition under the same parent would break that. The
row's cell carries the name and NOTHING else (no `(active)` suffix): which row
is pinned is read off its disabled control, and the block note names the
session, which is where a disabled control's explanation has to live since a
disabled input's own tooltip never fires.

**The modal caps its own height and scrolls, with the action row `position:
sticky`.** Three tables plus two cautions is ~975px, so Cancel / Continue would
otherwise sit below the fold on a laptop. Sticky keeps it to ONE scroller, per
the no-scroll-within-scroll rule; the tables never get their own.

**The 2D rows are the whole population, with the grouped subtotal beside
them** (`12,480 — 2,604 in instance groups`). They are inventory, not work
— 2D does not move — but a user whose project is mostly ungrouped
predictions was told it held none.

**The origin-dependent table's headline is the SUM, and every sub-row under it
is a count of POINTS.** `3D points to update` quotes `tally.points3d`; beneath it sit the
three pose buckets and `plane nodes`, and they add up to it. The group counts
moved into the row LABELS (`from 2 User instance groups`) because a heading that
says "3D points" with a number of groups under it is two units in one column.
The same rule governs the success status line, which names the total and then
spells out the pose/plane split rather than printing `0 3D points, 9 plane
nodes` and leaving the reader to reconcile it. Pinned by
`tests/e2e/set-new-calibration.mjs` §1 (the sub-rows sum to the headline) and
§5 (a planes-only project, where the headline is the plane node count and every
pose bucket is zero).

**Key exports.** `showSetCalibrationModal()`,
`runSetCalibration(sessions)` — whose argument is the CHOSEN subset, not
necessarily every loaded session — and `resetCalibrationHandle()`. The file name itself is
`REBASED_CALIBRATION_NAME`, from `loading/calibration-pick.js` — a module with
no imports, so both origin actions and the folder loaders can read it without
crossing the `origin-rebase` / `origin-definition` cycle.

**Tests.** `tests/e2e/set-new-calibration.mjs` (the dialogs, both cancels, the
commit, the new file name and both warnings) and
`tests/e2e/origin-rebase-slp-diff.mjs` (saves the same project on each side of
the re-base and diffs every HDF5 dataset — what changes in `project.slp`, what
does not, and the negative control showing what a leftover `calibration.toml`
costs).

**After the swap** (`finishRebase`) the defined origin is **cleared**, not kept:
the project is now expressed in that frame, so the offset from it is zero and a
table still reporting the old rotation would describe a transform that has
already happened. The grid goes back to the world axes for the same reason.
`state.triangulationResults` (and each session's) is dropped rather than
transformed — it is derived from 3D that just moved — and the 3D viewport is
rebuilt, not merely re-framed, because the skeletons in it are built from
`points3d`.

**Imports from project modules.** `./app-state.js`, `../import-export/save-load.js`,
`../import-export/file-io.js` (`exportCalibrationTOML`, `downloadTOML`),
`../pose/origin-rebase.js` (`countRebaseTargets`, `subsetRebaseTally`,
`planOriginRebase`, `applyOriginRebase`), `./rendering.js`,
`../pose/initialization.js`, and
**circularly** `./origin-definition.js` + `./plane-definition.js`, call-time use
only.

**Imported by.** `ui/origin-definition.js` (which owns the button).

**Tests.** `tests/e2e/set-new-calibration.mjs` — the modal's inventory, Cancel at
the confirmation, Cancel mid-flight (asserting no file was written and not one
coordinate moved), and the commit: the file goes to a stand-in
`FileSystemFileHandle` (headless Chromium exposes `showSaveFilePicker` but
rejects it instantly with `AbortError`, the same reason
`video-encode-streaming.mjs` supplies its own), every probe point keeps its
pixel, and the origin collapses.

---

### ui/calibration-notice.js

**Purpose.** The modal that tells the user a multi-session project's sessions do
not all carry the same calibration. Raised at the END of a multi-session load,
once every session is in `state.sessions`.

**Why it has to exist at all: the failure is INVISIBLE.** Each session still
reprojects correctly against its own cameras, so every error stays small and
every number stays plausible. What is broken is only the comparison BETWEEN
sessions — which nothing on screen performs, and so nothing on screen
contradicts. Without the note the user finds out when a distance measured in one
session does not match the same distance in another, long after annotating both.

**Silent in the ordinary case, and that is the point.** The sessions of one
project normally carry copies of a single calibration, so the modal opens only
when `compareSessionCalibrations` reports `ok === false`. A note on every
multi-session load would be worse than no note.

**It is a NOTE, not a prompt.** One dismiss button, and it changes nothing.
Offering to fix the divergence here would mean writing to the user's session
folders during a load, which is not what a load is for.

**It says WHO differs and nothing else.** One fixed title — *Sessions with
different calibrations detected* — then one `.calib-notice-group` section per
distinct calibration: a letter (`Calibration A`), `N sessions · M cameras` on
the title row, and the session FOLDER NAMES one per line, monospace, capped at
10 with `and N more`. Plus one line naming any session excluded for having no
calibration at all. That is the entire modal.

Removed, and asserted absent by the e2e test: a lead paragraph, a per-`kind`
explanation of the difference, the measured offset, a consequence paragraph and
two numbered remedies. Five blocks of prose over a two-row table is a document,
not a note — nobody reads it on the way into a project, and the one string they
need (the odd folder's name) was buried in it. Three rules follow:
- **No branch on `report.frameOnly`.** The title and the layout are the same for
  all four `kind`s, because the user's next move is the same either way: open
  the folder the modal names. The classification is still computed, and
  `noteSessionCalibrationDivergence` LOGS it with the measured offset — the
  console is where someone asking "how different?" is already looking.
- **The largest group is listed FIRST** (`report.reference`, so the modal cannot
  disagree with the console line), which puts the odd session out last.
- **The letter is not read off the file name.** Two groups routinely both loaded
  a file called `calibration.toml`, so the letter is the only handle a group
  has.
The remedies moved to where the divergence is created: the
`Set as New Calibration` confirmation's `#originRebaseMultiNote` states the
obligation to deal with the other session folders before it writes the file
that causes this.

**Key exports.** `noteSessionCalibrationDivergence(sessions)` — compares, logs
(including the offset and `kind` per divergent group), shows the modal if
needed, and returns the report (or null). Wrapped in a try/catch: a load must
never fail because of a check that only prints a note.
`showCalibrationNoticeModal(report)` builds the dialog. Esc closes it, per the
project's modal rule, and it reuses `.plane-confirm-overlay` plus
`.origin-rebase-block` / `-block-title` / `-block-note` so the scrim, z-index,
height cap and sticky action row are the origin dialogs' existing ones. Its own
classes — `.calib-notice-group{,-title,-count}`, `.calib-notice-session{,s}` —
are in `styles.css` beside those. Its titles are plain `<div>`s and stay
un-foldable: the folding rules `ui/origin-rebase.js` added are scoped to
`summary.origin-rebase-block-title`, so sharing the class costs nothing here.

**Imports from project modules.** `../pose/calibration-compare.js`.

**Imported by.** `loading/session-loader.js` (`handleLoadMultiSession`),
`import-export/slp-import.js` (the multi-session `.slp` path).

**Tests.** `tests/e2e/multi-session-calibration-notice.mjs`.

---

### ui/plane-angle.js

**Purpose.** The dialog and the commit for **Set Angle Between Two Planes** —
the UI half of `pose/plane-angle.js`. That module plans purely; this one asks,
previews and writes, the same split `planPlaneFit` / `applyPlaneFit` uses and
for the same reason: the geometry must be inspectable and refusable before
anything is written.

**Why a modal rather than a mode.** Set Origin is a wizard because its inputs
are PICKED in the 3D view (a corner, then an axis arrow). This action's inputs
are two planes and a number, which a form states better than a sequence of
clicks — and they could not be picked in 3D as things stand: plane FILL meshes
carry no `userData`, so only corners are raycastable and there is no "click a
plane" gesture to reuse.

**What the commit does, in order, because the order is load-bearing.**
1. write the rotated 3D through `writePoints3dForPlane` — the one sanctioned
   publish path, which skips LOCKED nodes and routes PLANE-LOCKED ones through
   `PlaneModel.constrainPoint3dForNode`.
2. install the ROTATED fit (`rotatePlaneFit`) rather than re-fitting, so the
   normal's sign cannot flip.
3. reproject the moved corners into every 2D view the plane is placed on,
   exactly as `applyPlaneFit` does, so the annotation agrees with the 3D. Only
   the corners that MOVED are rewritten — a hinge corner's 2D is the user's
   observation of a point that did not move. The reprojection reads each node's
   ACTUAL position, not the plan's, because the constrain hook may have moved a
   plane-locked node off it.
4. clear the stored fit of any OTHER plane whose nodes moved.
5. **Hold the moved nodes PLANE-LOCKED to the plane that moved.** This is what
   makes the angle durable: without it the next Triangulate on that plane
   re-solves those corners from 2D and silently throws the angle away.
   Plane-locked rather than Locked because what the user asserted is the
   plane's ORIENTATION, not where each corner sits on it — a held corner is
   still re-solved and `constrainPoint3dForNode` projects the answer back onto
   the planes it belongs to — the rotated one among them — so the annotation
   goes on improving while the angle survives, instead of every later solve of
   this plane being a no-op the user has to unpin their way out of. A node the
   user had already Locked is left Locked: that is a stronger promise they made
   deliberately. It nominates NO plane, because the pin no longer takes one: a
   corner this rotation moved is in the rotated plane by definition. It still
   happens LAST because step 1 writes through the same constrain hook and until
   step 2 the stored fit is still the OLD one — a node pinned any earlier would
   have had its rotation projected straight back onto the plane it was being
   rotated off.

   **A held corner shared with another plane may miss the target**, and that is
   what `plane_locked_elsewhere` warns about: the pin holds it in that plane
   too, so the commit projects it back there and the rotation is no longer
   exactly rigid for it. Reported, never refused.

**Which planes it offers: usable, not fitted.** `fittedPlanes()` — what Set
Origin asks — is the wrong question here, and asking it listed **2 of a user's
5** annotated planes. A plane loses its stored `planeFit` for reasons that say
nothing about whether it HAS a plane: pinning a node clears the fit of every
plane standing on it (and this action's own auto-lock does exactly that), and a
plane that was triangulated but never Fitted never had one. Set Origin genuinely
needs the stored fit, because it offers that plane's corners as an origin; this
action only needs to know WHERE the plane is, which the triangulated corners
already say. So `usableFit` returns the stored fit or derives one — it now
delegates to the model's `usablePlaneFit`, so this dialog and the
`plane-locked` pin cannot disagree about where a plane is — and **nothing is
written**: deriving is a measurement,
and opening a dialog must not mutate the project. The PLAIN fit, not the
constrained one: this value is rotated with the points, and a TLS fit is exactly
equivariant under a rigid motion where an anchor-constrained fit is not.

**Key exports.**
- `usableFit(plane, model)` → the plane's stored fit, else one derived now, else
  null (fewer than 3 solved corners, or they are coincident or collinear). A
  thin wrapper over `PlaneModel`'s `usablePlaneFit`, kept as the name this
  dialog and its tests were written against.
- `anglePlanes()` → every plane with a usable fit, in model order.
- `showPlaneAngleModal()` — the dialog: two plane `<select>`s (picking the same
  plane in both swaps them rather than producing a dead form), a swap button, a
  readout of the current angle and the hinge, a target field, the plan's
  warnings (each line is the warning's `message`, with its optional `detail` —
  the untruncated node/plane list the narrow line had to cap — set as the
  line's `title` tooltip), Cancel / Apply. **Esc cancels**, via a capture-phase `keydown`
  listener, per the app-wide modal convention. Refuses up front with
  `showPlaneDialog` when fewer than two planes are usable, rather than opening a
  form that cannot be completed. The derived fits are handed to `planAngleEdit`
  as its `fits` argument, which that module keeps as a test seam (see
  `pose/plane-angle.js`).

**It is the one plane dialog that is NOT modal.** Alone among them, its inputs
are two planes the user has to ORBIT to tell apart — "back wall" and "front
wall" are indistinguishable in a dropdown — and the thing it is asking about is
in the 3D view. So:
- the backdrop draws no scrim and takes `pointer-events: none`, with the dialog
  itself taking the pointer back, leaving the 3D view live underneath;
- `parkBesideViewport` opens it to the LEFT of `#viewport3dContainer` instead of
  centred over it (falling back to the screen's left edge, never off it), and
  the header still drags it anywhere;
- the two chosen planes wear matching coloured outlines in the scene
  (`viewport3d.setPlaneRoles`), keyed to a swatch beside each dropdown —
  `ROLE_FIXED_COLOR` `#4da3ff` for the one held, `ROLE_MOVING_COLOR` `#ffd24d`
  for the one that moves. Deliberately not the planes' own colours, which would
  make the roles mean something different in every project.
- **Apply re-plans before committing.** A live 3D view means the scene could
  have changed since the last input change, and `lastPlan` would then describe
  geometry that no longer exists. The plan is pure, so re-running it is free.

Esc still cancels: that listener is on the document and owes nothing to the
backdrop.

**But "live view" is not "live data" — the EDIT LOCK.** Everything the dialog
says (the current angle, the hinge, the ghost's shape) is read from plane
geometry, so letting that geometry change underneath it produces a readout
describing a scene that no longer exists and a ghost drawn from corners that
have moved. While the dialog is open, plane data is therefore frozen in all
three places it can be edited from:
- `refreshPlanePanel` ends in `applyAngleModalLock`, which disables every
  `button` / `select` / `input` in `#planePanel` and puts `plane-angle-lock` on
  `<body>` (the class does what `disabled` cannot: dim the panel so the lock is
  visible, and stop the `<summary>` elements folding sections away);
- `syncPlanes3D` pushes `editable: false`, which makes 3D corners inert — no
  drag, and no `move` cursor advertising one;
- `beginPlaneDrag` refuses a 2D corner drag with a status line saying why, and
  its two siblings close the paths that do not go through it: the
  `isPlaneDataLocked` callback (the right-click null toggle, which invalidates
  the node's 3D) and a guard in `handlePlaneDrop` (dropping a plane row onto a
  view — a `<tr>` takes no `disabled`).

All three ask `isAngleModalOpen()` on every render rather than being toggled by
hand, so there is no lock state to get out of step and a mid-dialog re-render
cannot leak an unlocked control. Unlocking needs no bookkeeping either: those
renders recompute each control's real disabled state, so not re-disabling it is
correct. What stays live: orbiting, zooming, panning, selection, the ghost
preview, the dialog's own Cancel and Apply (they are in `document.body`, not in
the locked panel) — and pose annotation, which cannot touch a plane.
`exitPlaneMode` calls `closeAngleModal`, the same way it unwinds Set Origin
Mode: a dialog that holds this panel locked must not outlive it.
- `applyAngleEdit(plan, fixedPlane, movingPlane)` → `{ok, movedPx,
  skippedNames, constrainedNames, heldNames, stalePlaneNames, achievedDeg}`.
  One `markDirty()`, then the panel's mutation quartet.
- `renderAngleButton()` — enable/disable `#btnSetPlaneAngle` with the reason in
  its `title`, modelled on `renderOriginButton`. **Two** usable planes, not one:
  an angle is a relationship.
- `setupPlaneAngle()` — wire the button; called once from
  `setupPlaneDefinition`.
- `closeAngleModal()` — tear the dialog down, clear the ghost and the role
  outlines, and lift the edit lock. Exported for `exitPlaneMode`.
- `isAngleModalOpen()` — read by the three edit-lock guards above.

**The live plan.** Every input change re-runs `planAngleEdit` and stores the
result; Apply commits exactly that stored plan, so Apply can never act on a
staler state than the readout shows. The plan is pure, so doing this per
keystroke writes nothing.

**The target field.** Commit-on-`change` with **revert-on-invalid**, the panel's
convention — and the EMPTY case is checked before `Number`, which would read
`''` as 0, a silent, plausible and wrong answer ("make these planes parallel").
`keydown` is `stopPropagation`'d so the app's hotkeys do not fire while typing.

**DOM it owns.** `#planeAngleOverlay` (`.plane-confirm-overlay`, reused
wholesale), `.plane-angle-modal`, `#planeAngleFixed`, `#planeAngleMoving`,
`#btnPlaneAngleSwap`, `#planeAngleReadout`, `#planeAngleTarget`,
`#planeAngleWarn`, `#btnPlaneAngleCancel`, `#btnPlaneAngleApply`. The panel
button `#btnSetPlaneAngle` is static markup in `index.html`, in its own
`.panel-button-row` after `#btnSetOrigin`; it is caught automatically by origin
mode's `lockUI` selector (`.plane-panel button`) and so must **not** be added to
`UNLOCKED_IDS`. Styles: `styles.css` § "Set Angle Between Two Planes".

**No keyboard shortcut**, so no `ACTION_CATALOG` entry — matching Set Origin.

**Imports from project modules.** `./plane-definition.js` (circular, call-time
only — `planeModel`, `planeState`, `refreshPlanePanel`, `syncPlanes3D`,
`showPlaneDialog`, `refreshTriangulationErrors`), `../pose/plane-data.js`
(`writePoints3dForPlane`, `points3dForPlane`), `../pose/triangulation.js`
(`reprojectPointCamera`, `fitPlaneToPoints3d`), `../pose/plane-angle.js`,
`./app-state.js`, `../import-export/save-load.js`, `./rendering.js`.

**Imported by.** `ui/plane-definition.js` (`setupPlaneAngle`,
`renderAngleButton`, `isAngleModalOpen`, `closeAngleModal`).

**Tests.** `tests/e2e/plane-angle.mjs` — the button's gating, the dialog, the
ghost preview, Apply, the auto-hold, and (§8) that a plane whose stored fit was
cleared by a pin is still offered, (§9) that the dialog parks beside the 3D view
and leaves it clickable with both planes outlined, (§10) the edit lock — that
corners are draggable in 2D and 3D before the dialog opens and neither is while
it is open, that all 63 of the panel's controls go disabled while the dialog's
own two stay live, that the ghost still follows the typed angle while the data
is frozen, that closing restores each control to its OWN state rather than
blanket-enabling, and that leaving Defining Plane Mode closes the dialog. §5b keeps the Triangulate
locked-nodes modal covered, which is now the only place it is asserted. §4/§5
are the pair that make the hold observable: with the corners held, a Triangulate against PERTURBED 2D
moves them and still lands them at 90°; set Free, the same solve walks them off
the plane. Both measure the angle from the CORNERS (`__pointAngle`), not from
the stored fit — a stored fit is not re-derived when a node moves, so measuring
it would have reported 90° either way.

---

### ui/mesh-objects.js

**Purpose.** The **3D Mesh Objects table** — a third table under Nodes and
Planes, for the third layer of the model (a node is a point, a plane is a group
of nodes, an object is a group of planes). Create, name, recolour and delete an
object; add and remove its member planes; and read a connectivity report of the
shape those planes imply. No orientation control — winding is derived (see
`pose/mesh-object-geometry.js`).

Deliberately its OWN module rather than more of `ui/plane-definition.js`. That
file already owns the mode, the placements, the drags and two tables; this
feature is strictly additive, so keeping it separate is what makes the "nothing
existing changes" claim checkable — `plane-definition.js` gains one import, one
`setupMeshObjects()` call and one `refreshMeshObjectsPanel()` call, and that is
the whole of its involvement.

**Key exports.** `meshObjectState` (`{selectedObjectId}` — panel-local, NOT
persisted), `getSelectedMeshObject()`, `meshObjectGeometry(obj)` (builds in the
applied origin frame at scale 1, so reported numbers match the viewport),
`refreshMeshObjectsPanel()`, `createMeshObject(name)`, `deleteObject(obj)`,
`setupMeshObjects()`.

**Everything shown is DERIVED.** The report and the member list are recomputed
from the model on every render — the underlying 3D can move at any
moment (a node drag, a re-triangulate, a fit, an origin change), and
`buildMeshObjectGeometry` is cheap at this scale while being wrong is not.

**The report is written to be actionable**, and says nothing the reader cannot
act on. The counts are there, but what a user needs is the next move: a
multi-shell object says that joining requires SHARING a node, and
coincident-but-unshared nodes are named as pairs — the "I thought I joined it"
case, which is invisible in the viewport because the two corners are drawn on
top of each other.

By the same rule it **says nothing about normals**, and a single-shell OPEN
object gets no line of its own. Winding is derived and has no user control
(`pose/mesh-object-geometry.js`), so the paragraph explaining which way an open
object had been oriented was the longest thing in the box and the one nobody
could do anything with; and "open" is the ordinary state for a cage with no lid
rather than a finding. Closed still reports its volume, because a number is not
prose. Pinned by `tests/e2e/mesh-object-roundtrip.mjs` §2.

**There is no Shape column.** The table listed a per-row badge — `closed`,
`2 shells`, `open — 6 naked` — whose terms the panel defined nowhere once the
report's explanatory line went. A one-word verdict in vocabulary the reader does
not have is not a verdict; it is a prompt to ask someone. Everything ACTIONABLE
about connectivity is in the selected object's report, in sentences, so nothing
was lost but the jargon. A row is now swatch / name / planes / delete, and the
table no longer derives every object's full geometry on every repaint in order
to print one word. `tests/e2e/mesh-object-roundtrip.mjs` §2 asserts the badge,
the header cell and the fifth `<td>` are all gone.

**Membership is edited by PICK-AND-ADD**, the same idiom the Planes section
uses to put an existing node in a plane: `renderMembers` lists the planes IN the object, one
row each with an × to take it back out, and `renderAddPlaneSelect` offers a
`<select>` of the NON-members plus `+ Add` (`#meshObjectAddPlaneSelect` /
`#btnAddMeshObjectPlane`). It replaced a checkbox against every plane in the
project, which made the list grow with the PROJECT rather than with the object
and never said which planes were actually in it without reading every row. An
empty picker is a real state — every plane is already a member — and it is said
in words with the button disabled, not left as a dead dropdown. A member whose
plane was since deleted still gets a (greyed) row, because its × is the only way
to clear the stale id.

**What this module may NOT do.** Nothing here creates, deletes or edits a node or
a plane. An object is a grouping: dissolving it cannot destroy its members, and
removing a plane from an object must not delete the plane. The panel's only
destructive action is the object's own ×, which removes the grouping and nothing
else. That constraint is what keeps 3D Mesh Objects from being able to break a
workflow that predates them.

**Export.** `Export .stl` / `Export .glb` (`#btnExportMeshStl` /
`#btnExportMeshGlb`) sit in the editor, because they act on the SELECTED
object. Both write the geometry `meshObjectGeometry` already reports on —
origin frame applied, scale 1 — so the file and the badge above it cannot
describe different shapes, and the calibration's own millimetres reach the file
unscaled. They are DISABLED, with the reason in the tooltip, until the object
has triangulated faces: both writers would refuse, and saying so on the button
beats letting the click land and reporting a failure afterwards. Neither marks
the project dirty — an export writes a file, not a change, the same reason the
appearance sliders do not. The formats themselves, and the one sanctioned axis
conversion, are `import-export/mesh-export.js`.

**Imports from project modules.** `./plane-definition.js` — `planeModel`,
`refreshPlanePanel`, `syncPlanes3D` (circular, and safe for the same reason the
rest of this feature's cycles are: every use is inside a function body);
`./origin-definition.js` — `originState`; `../pose/mesh-object-geometry.js`;
`../import-export/save-load.js` — `setStatus`, `markDirty`;
`../import-export/mesh-export.js` — `meshObjectToSTL`, `meshObjectToGLB`,
`isExportable`, `meshFilenameStem`; `../import-export/file-io.js` —
`downloadBytes`.

**Imported by.** `ui/plane-definition.js`.

**Selection is visible.** The selected object's row carries `.plane-selected`
and `#meshObjectsTable tbody tr.plane-selected` styles it exactly as the Planes
table styles its own selection. The class was always applied; the rule was
missing, so the editor below appeared to be attached to nothing.

**Tests.** `tests/e2e/mesh-object-roundtrip.mjs` (the panel driving the model
through real DOM handlers, the pick-and-add membership editor and the selected
row's marking, the dirty flag per mutation, the derived shape tracking
membership, save → reopen by ID, the PROJECT scope, and three negative controls:
untouched projects write no key, the feature is additive, and deleting an object
keeps its planes and nodes); `tests/e2e/mesh-membership-highlight.mjs` (what the
3D viewport actually draws for a selection); `tests/e2e/mesh-object-export.mjs`
(the two export buttons).

---

### ui/seekbar-markers.js

**Purpose.** Possible-ID-switch ticks on the transport seekbar (`#seekbarMarks`
inside `#seekbar`), for the active session's ID Switches results — where the
timeline used to draw them.

**Key exports.** `installSeekbarMarkers(layerEl, totalFrames)`;
`setSeekbarSwitchMarkers(markers, totalFrames)` (`[]` clears) /
`getSeekbarSwitchMarkers()`; `setSeekbarMarkerFrames(totalFrames)` (re-lays the
ticks out only when the frame count changed — called from `updateSeekbarVisual`);
`seekbarMarkerAt(frac, widthPx, tolPx = 5)` (the tick nearest the cursor; a change
point beats a repeat); `describeSwitchMarker(m)` (the tooltip text).

**Drawing.** One tick per marker at `frame / (totalFrames - 1)` — the thumb's own
mapping: amber = size, cyan = images, amber-over-cyan = "Both" (drawn once, on the
size marker; its image twin is skipped), follow-on fainter and shorter,
still-swapped repeat a short faint tick, `reviewed` (ticked in the tab) dimmed.
Over the track, under the thumb, `pointer-events: none`: the seekbar's
mousedown/drag handlers (`ui/ui-wiring.js`) snap to a tick within 5 px, and the
seekbar tooltip names it ("Frame 18,105 · 05:01.733 — possible ID switch: id_1 ↔
id_2 (size score -1415)").

**Imports from project modules.** None.

**Imported by.** `ui/ui-wiring.js`, `ui/id-switch-modal.js`.

**Coverage.** `tests/e2e/size-switch-check.mjs` (ticks drawn, none on the
timeline, hover text, click snaps to the tick's frame, reviewed dimming).

---

### ui/seekbar-tooltip.js

**Purpose.** Hover tooltip on the transport seekbar (#142): "Frame 1,234 ·
00:41.100" for the point under the cursor, so you can see where a click or
drag will land before making it.

**Key exports.** `formatTimestamp(seconds)` (`mm:ss.mmm`, `h:mm:ss.mmm` from an
hour up; rounds to the millisecond before splitting, so never `00:60.000`),
`seekbarTooltipText(frameIdx, fps)`, `installSeekbarTooltip(seekbar,
{frameAtFraction, getTotalFrames, getFps, markerAt?})` -> the tooltip element
(`markerAt(frac, widthPx)` -> `{frame, text}` | null: a possible-ID-switch tick
under the cursor — its frame replaces `frameAtFraction`'s, as the scrub handlers
snap to it, and its text is appended)
(`#seekbarTooltip`, `.seekbar-tooltip`).

**Behaviour.**
- The frame shown is EXACTLY the one a click there seeks to: the caller passes
  the scrub handlers' own `frameAtFraction` mapping. It is shown **1-based**, like
  `#currentFrame` and every other frame number on screen.
- The timestamp is the frame's start time, `frameIdx / state.fps`, and is left
  out when the frame rate is unknown (`state.fps` is 0 while a session has no
  video yet).
- Visible while hovering the bar and throughout a scrub drag (document-level
  mousemove, so it keeps tracking after the pointer leaves the bar); hidden on
  leave / release outside, and never shown when `totalFrames <= 1`. Centred on
  the cursor and clamped to the bar's extent; `pointer-events: none` so it
  cannot steal the hover.
- **Layout-free while moving**, so hovering during playback adds no forced
  synchronous layout to the frame: the bar's rect is read on mouseenter / drag
  start and cached (a `ResizeObserver` and window `resize` drop it — the bar's
  width moves when the frame counter beside it gains a digit), and the bubble
  is measured only when its text LENGTH changes (monospace font). A move with
  an unchanged length only writes.

**Imports from project modules.** None (dependency-free, so the text half runs
in Node).

**Imported by.** `ui/ui-wiring.js` (installed inside the seekbar-scrubbing
IIFE in `setupUI`), `ui/frame-readout.js` (`formatTimestamp`, so the frame
readout's time row reads exactly as this tooltip does).

**Coverage.** `tests/test-seekbar-tooltip.mjs` (formatting) and
`tests/e2e/seekbar-tooltip.mjs` (real mouse events: follows the pointer,
tooltip frame == the frame a click lands on, drag off the bar, edges clamped,
drawn on top of the timeline, no timestamp at fps 0, and zero layout reads
across a run of hover moves).

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
- `scrollViewStripTo(viewName)` — scroll that view's strip item into sight.
  `.view-strip-list` is `overflow-y: auto`, so on a project with more cameras
  than fit the column, arrow-cycling the solo view would otherwise move the
  highlight somewhere off screen. Called by `cycleSingleView`.
- `activatePanelForView(viewName)` — activate the first docked panel showing a
  view, returning false when it isn't docked. That `setActive()` is what drives
  the yellow `strip-selected` highlight, `lastInteractedView` and the 3D camera
  highlight (see `onDidActivePanelChange`), so it is the single way to say
  "select this view". Shared by `addVideoPanel`'s duplicate guard, both view
  strip handlers, and `ui/ui-wiring.js`'s `setGridMode`.
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
- `./id-switch-modal.js` — `refreshIdSwitchPanel`: `switchSession` shows the new
  session's ID-switch results and markers (try/catch, like `populateTimelineVisibility`).
- `./app-state.js` — `state`, controllers + setters.
- `../pose/pose-data.js` — `FrameGroup`, `UnlinkedInstance`, `Camera`,
  `pooledPoints3d` (the re-solved groups' 3D).
- `../pose/lazy-residency.js` — `hydrateFrameMembers2d`, `releaseFrameMembers2d`.
  `moveVideosToSession` re-solves every origin-session group that loses the
  moved view, and on a lazy project a member of a non-resident frame is a
  `_lazy2d` placeholder (after a reopen, and since #280 after Track All /
  Triangulate All). Triangulating placeholders found no 3D, so each such group
  silently KEPT its old points3d — solved WITH the moved view — and was marked
  clean. Each affected frame's members are now hydrated from the store for the
  re-solve and given back after, as the image ID-switch check does. Covered by
  `tests/e2e/move-video-lazy-members.mjs` (fails 0/10 non-resident groups
  re-solved without the hydration). Unchanged and still resident-only: step 1
  moves the moved camera's 2D for RESIDENT frames only — its rows for every other
  frame stay in the origin session's lazy store.
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
- `./ui-wiring.js` — `setSoloView`. A **cycle** (`ui-wiring.js` imports this
  module), hoist-safe because the only read is inside the view strip's click
  handler, which cannot run during module evaluation.
- `./info-panel.js` — `updateInfoPanel`.
- `./frame-readout.js` — `clearReadout` (session removed),
  `refreshReadoutTotals` (`switchSession` restoring a cached frame count / fps).
- `./identity-assignment.js` — `autoAssignState`.
- `../pose/initialization.js` — `setup3DViewport`.

**Imported by.** `pose/initialization.js`, `ui/info-panel.js`,
`ui/identity-assignment.js`, `ui/ui-wiring.js`, `ui/view-align-modal.js`
(`syncRotationUI`), `loading/session-loader.js`, `import-export/save-load.js`,
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

**View strip click behaviour.** Ctrl/Cmd+click multi-selects (for drag-docking
several views at once). A plain click clears the multi-selection and then does
exactly ONE of three things, in order:

1. in **single-view mode**, `setSoloView(name)` (`ui/ui-wiring.js`) makes that
   view the solo'd one, *replacing* the current pane (luc3d #173). This used to
   require a double-click, which docked a SECOND pane beside the solo'd view
   instead of swapping it, so solo mode quietly stopped being solo;
2. if the view is already on screen, `activatePanelForView(name)` focuses its
   pane;
3. otherwise the view was **closed** (the user hit the pane's X) and
   `addVideoPanel(name)` **re-opens** it (luc3d #143). There was previously no
   discoverable way back: double-click did it, but nothing said so, and the
   workaround people found was to create a new session and close it again just
   to force a full rebuild.

**There is deliberately no `dblclick` handler.** The click handler covers every
case, and a double-click is two clicks — the first re-opens or focuses the view,
the second focuses it again, landing on the same state. A separate dblclick path
would only be a second route to that state, out of sync the moment one of them
changes. Note `addVideoPanel` refuses to dock a view twice (it activates the
existing pane instead), so no click sequence can produce a duplicate pane;
duplicates come only from the drag/drop docking path and `addAllViewsAsGrid`.
See **Single-view ("solo") mode** under `ui/ui-wiring.js`.

**`removeVideoPanel(viewName)` — the counterpart to `addVideoPanel`.** Closes
EVERY pane showing that view and returns how many it closed. Used by
`removeVideoFile` (`loading/session-loader.js`) so the Videos tab's **Remove
Video** takes the whole panel out of the dock instead of leaving an empty,
still-titled one behind (luc3d #216). Three things about it:
- It goes through `panel.api.close()`, exactly as the pane's own × and
  `clearAll` do — `onDidRemovePanel` is what decrements `dockedViews` and clears
  the strip's in-dock dot, so tearing the element out by hand would leave both
  claiming the view is still docked.
- **Every** pane, not the first: a view can be docked more than once (a dropped
  multi-selection, or an `addAllViewsAsGrid` restore), and a survivor would go
  on rendering a view that no longer exists.
- Panes are matched through `panelRenderers`, never by parsing the panel id —
  the id is `video-<name>-<counter>` and a view name may itself contain dashes.
It also deletes the `dockedViews` entry outright afterwards, so a view left in
the map with no pane (bookkeeping that got out of step) cannot block a later
re-add.

**`syncDockedViews()` — `fromJSON` builds panels behind `addVideoPanel`'s back.**
`paneManager.dockedViews` (viewName → pane count) is maintained by
`addVideoPanel` / `addAllViewsAsGrid` / `onDidRemovePanel`, and it drives both
the strip's in-dock dot and `activatePanelForView`'s early-out. `api.fromJSON()`
— used by `setGridMode` to restore the cached grid layout — constructs panels
directly, so none of that bookkeeping runs and the counts read EMPTY afterwards:
a plain strip click on a view that is visibly on screen did nothing, and a
double-click docked a duplicate pane. `syncDockedViews()` re-derives the counts
(and the dots) by walking `api.panels` through `panelRenderers`, and
`setGridMode` calls it immediately after `fromJSON`.

**`addAllViewsAsGrid()` leaves solo mode.** Laying every view out as a grid IS
grid mode, so it sets `state.viewMode = 'grid'` and removes the solo chip
(`#viewModeIndicator` + the dock's `has-view-indicator`). The loaders, session
switches and `removeSession` all rebuild the dock with `clearAll()` +
`addAllViewsAsGrid()`, and only `newProject` used to reset the mode — so a load
made while a view was solo'd showed the grid with the mode still `'single'`, and
`v` (a no-op when already solo) silently did nothing until `g`. Pinned by
`tests/e2e/solo-view-navigation.mjs` §6.

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

### ui/id-switch-modal.js

**Purpose.** Tracks ▸ **Check ID Switches (Body Size)…** / **(Images)…**, and the
same checks run automatically after Track All / Track Frame Range. Runs
`checkSizeSwitches` / `checkImageSwitches` (`pose/id-switch-check.js`), puts every
change point and repeat on the transport seekbar (`setSeekbarSwitchMarkers`, `ui/seekbar-markers.js`; tagged
`cue: 'size' | 'image'`), and lists the change points in the right panel's
**ID Switches** tab as a per-session review checklist.

**Key exports.** `runIdSwitchChecks({size?, image?, auto?, statusPrefix?,
navigateToFrame?, inject?})`; `setIdSwitchNavigator(fn)` (ui-wiring registers
`navigateToFrame` once, so rows stay clickable when the tracker started the
check); `setIdSwitchRefresher(fn)` (ui-wiring registers the repaint run after a
fix / undo — overlays, 3D, info panel, timeline — keeping this module a leaf); `refreshIdSwitchPanel(session?)` (render the tab and put that session's
markers on the seekbar — called after a check, from `updateInfoPanel` and from
`switchSession`); `openIdSwitchPanel()` (show the panel, if hidden, on the tab);
`clearIdSwitchResults(session?)` (called by `runTrackingPass` before it relabels);
`ID_SWITCH_LEAD_IN_SECONDS`, `idSwitchLeadInFrame(marker, fps)`,
`updateIdSwitchProgress(frame)`; back-compat
`runSizeSwitchCheck`. `inject: {createEmbedder}` replaces the image model —
test-only (`tests/e2e/id-switch-image-check.mjs`).

**Runs automatically after tracking.** `pose/tracker.js`'s `runTrackingPass` calls
`runIdSwitchChecks({auto: true, statusPrefix, size, image})` after BOTH Track All
and Track Frame Range: size when the Tracking Wizard's `autoSwitchCheck` is on
(default), images when `autoImageSwitchCheck` is on (default OFF — minutes, needs
the videos; with no GPU it runs on the CPU, slower, rather than being skipped). Auto mode appends each check's result to the pass's status
line ("Assigned N identities … · ID-switch check (body size): …; ID-switch check
(images): …"), opens the ID Switches tab only when a possible switch is found, and reports
a check that cannot run as "skipped — reason", never as a failure of the pass. It
always analyses the WHOLE session's identities. Each result it returns carries
`elapsedMs`, the check's wall-clock time (model download and video decoding
included), which the Track All summary box shows (`ui/track-summary.js`); it is
not saved — `serializeIdSwitchReview` (`ui/id-switch-review.js`) picks its fields explicitly.

**The image check.** Needs the session's videos (else it says why). Not a GPU:
without one the embedder runs the model on the CPU (`pickImageDevice` /
`createCpuModelPool`, ui/image-embedder.js), ~15x slower, and the check runs as
usual — from the menu and after tracking alike. It used to refuse ("needs WebGPU —
on the CPU it would take hours"), which was the wrong call for a user who had
opted in. `fmtDuration` therefore reaches hours ("about 2 h 5 min left"). Runs under its own cancellable progress dialog (Cancel / Esc -> "cancelled", no
markers added): model download (first use), "Cropping and embedding N views:
frame i of n — about X min left", then fitting, with the overall percentage under
the bar (the same rounded value as the bar's width; embedding is its first 90%) and
the ID Switches rows' playhead line (`.id-switch-phead`) at the fill's leading edge.
Under the percentage, the device line (`formatEmbedDevice`, ui/image-embedder.js):
"GPU: Apple metal-3 (WebGPU, fp16) · load 87%", the load refreshed every second
from the first embedded frame (`createLoadMeter` over `busyMs()`), so it falls to
0% while fitting, which runs on the CPU; with no GPU, "No GPU: running on the CPU
(4 workers) — slow" in the warning colour, why in its tooltip. An injected
embedder without `device()` shows no line. **Beside them, above Cancel, a sample
crop** (128 px, captioned "id_2 · cam5" with the animal's current label): exactly
the model input — greyscale, nose right, masked — turned back into pixels by
`inputTensorToPixels`, so bad keypoints show up as bad crops while the check runs —
with **the skeleton drawn over it** (`drawCropSkeleton`) in the animal's identity
colour over a dark outline, at the keypoints `cropPointsToInput` maps into the
crop, because a masked, rotated greyscale crop on its own reads as abstract. The
skeleton is on the dialog's canvas only; the model input is untouched.
It changes every `CROP_PREVIEW_MS` (400 ms), cycling through the embedder's
`sampleCrops()`, by TIME rather than every nth crop, since crops/s differs ~15x
between a GPU and the CPU. A draw costs ~0.1 ms of main thread (measured: frame
times 8.3 ms median with and without it at 4 Hz) and no GPU time — the tensor is
already on the main thread before its batch is uploaded. An embedder without
`sampleCrops` (the test fakes) shows no square. The dialog's `finally` also calls the
embedder's `releaseFrames` (idempotent): `checkImageSwitches` does too, but not
when it fails before its first frame, and the CPU workers hold ~600 MB each. On a
CPU run "About these flags" says the model ran on the CPU, instead of the GPU-busy
hint. Reads `imageCheckHz` (default 2)
and `imageCheckThreshold` (default -25). Measured on a real 5-min, 3-animal,
8-camera session in Chrome (HEVC from Google Drive), before streaming decode and
view selection: 370 s, ~20 crops/s end to end. Its encounter scores matched the
offline-calibrated ones (correlation 0.999). Speed now (5-mouse, 8 cameras, local
HEVC, 150 frames 32 apart ≈ the 2 Hz default, Chrome fp16 on an M-series Mac):
85 s seeking per frame -> 59 s streamed -> 24 s streamed at 3 views per animal
(32 s at 4, 16 s at 2) -> **21 s with crops cut in workers** (all views: 50 s) —
~9 min for a 30-min, 5-animal session. The model (~105 crops/s) is the floor, so
time scales with views per animal x `imageCheckHz`; decoding + cropping alone
would allow ~270 crops/s.
Reads `imageCheckMaxViews` (default 3) and passes it as `maxViewsPerAnimal`, and
`imageCheckWebNN` (default 0) as `webnn`; the embedder's `backend()` outcome is
attached to the result as `model` and its note shown under "About these flags";
`embedder.stats()` is attached as `timing`, logged to the console and shown there
as "Image check speed on this machine: …". Passes `inFlight: embedder.inFlight`.

**User-facing features.** The **ID Switches** tab (`#tabIdSwitches` /
`#idSwitchPanel` in `index.html`, third tab; at the default panel width it is
scrolled off the right of the tab bar, and `openIdSwitchPanel` scrolls it back
into view). Results are stored per session on `session._idSwitch` (`{results:
{size?, image?}, reviewed: Set, showRepeats, current}`), so they survive
closing/reopening the tab and switching sessions — and are SAVED in the `.slp`
(`metadata.lucid.idSwitchReview`, see `ui/id-switch-review.js`; ticking a row,
a new run and Clear mark the project unsaved) — until the check re-runs (a cue replaces only its own results; ticks on
change points it finds again are kept, matched by cue + frame + pair), "Clear",
or a new tracking pass. The tab shows a heading, per-check counts, "About these
flags" (the method, calibration figures, sampling rate, frame-rate warning and
the image backend note), a sticky toolbar ("N of M reviewed", **Next
unreviewed ▸** — the next unticked row after the current one, wrapping —
**Clear**, and "Show N later encounters that still look swapped"), then one row
per change point: a **reviewed** checkbox, time, `id_a ↔ id_b` (each name in its
identity's colour, as in the overlays), score, the encounter's span ("close
4:59.6–5:01.7 (frames 17,977–18,105)") with an **end ⇥** button, and
"frame N · check · note" (Both / size / images; "follows the switch at m:ss";
"labelling changes here; earlier encounters look swapped"; "still swapped"). A
change point both checks found (same pair within 1 s) is ONE "Both" row (scores
"size / image"). Clicking a row navigates there; ticking it dims the row and its
seekbar tick (`reviewed`). **Where a row lands:** an encounter's frame is the
LAST close sample (the labels are read from the tracklets AFTER it), so a swap
happens before it, while the animals are close; clicking a row therefore lands
`ID_SWITCH_LEAD_IN_SECONDS` (1 s) before the close spell STARTS
(`idSwitchLeadInFrame`, from the flag's `startFrame`; its end frame when the start
is unknown, e.g. a file saved before start frames were kept), so pressing play
shows the whole interaction; **end ⇥** jumps to the end frame, and Next
unreviewed uses the lead-in too. **The selected row's progress bar** pops up on
selection and follows the viewer's frame (stepping, scrubbing, playback):
0% at the landing frame (1 s before the close spell), the close spell — where a
swap would happen — red in the middle, the lead-in and lead-out orange, 100% at
1 s after the encounter's end; clamped outside that range. The section colours
come from `ID_SWITCH_SECTION_RGB` (`ui/id-switch-highlight.js`), set inline.
A **playhead** line (`.id-switch-phead`) marks the current frame at the fill's
leading edge and stands 4 px proud of the bar, so the coloured track is an inner
element (`.id-switch-ptrack`) that clips the fill and band to its rounded ends
while the bar itself does not clip; both move in the same style write.
**Clicking or dragging the bar goes to that frame** (`round(p0 + x·(p1 − p0))`),
like the transport seekbar; a `::before` gives it a hit area 7 px taller on each
side. It is a `pointerdown` on the list (window-level move/up listeners, the bar
re-found on every move so a panel rebuilt mid-drag cannot strand it, repeats of
the same frame skipped), and the click that ends the press is swallowed so it
never re-lands the row on its lead-in. `updateIdSwitchProgress(frame)` is
called from `ui/ui-wiring.js` `updateSeekbarVisual` on every frame change: one
style write, and a no-op without a selected row (the bar element is looked up
once per render/selection, not per frame). The same interval drives an
**animated box around the pair in every camera view** (`ui/id-switch-highlight.js`,
set by row selection and panel renders, advanced by `updateIdSwitchProgress`),
which wears the colour of the bar section the frame is in. A check run from the menu always opens the tab; an
automatic one only when it found something. The tab content is the panel's one
scroller (the list has none of its own). With no results it says so and offers
"Check by body size" / "Check by images…" (they click the menu items).

**Notes / caveats.** Kept a leaf like `ui/track-range-modal.js` (no import of
`pose/initialization.js`); it opens the panel through the DOM (the toggle button
and the tab button), not by importing ui-wiring. The module keeps its `-modal`
name for the image check's progress dialog, which is still modal.

**Fixing a switch.** The selected row shows **Fix switch…** under its bar. It
opens a confirmation naming the frames (`idSwitchFixPlan`, `ui/id-switch-review.js`)
and why each edge is where it is; Esc / Cancel / a click outside change nothing,
and every keystroke stops at the dialog (capture phase) so no app shortcut acts
under it. Confirming calls `Session.swapIdentitiesInRange` (every view), records
the fix in `st.fixes`, renames the other rows the swap re-labels, ticks the row,
marks the project dirty, repaints through the registered refresher and returns the
view to the row's lead-in, so pressing play shows the corrected labels. The row
then reads **Fixed** (not struck through) with the swapped frames and, on the
LATEST fix only, **Undo fix** — later fixes may build on an earlier one, so only
the last is exactly reversible; undo swaps the same frames back. A follow-on row's
dialog says to fix the switch it follows first. Re-running a check forgets the
fixes (the swaps stay): its rows were scored on the fixed labels, so an undo would
rename them wrongly.

**Imports from project modules.** `ui/app-state.js` (`state`, `timeline`,
`getActiveSession`), `import-export/save-load.js` (`setStatus`),
`ui/loading-overlay.js` (`showLoadingProgress`, `hideLoading`, `yieldToPaint`),
`ui/settings.js` (`getTrackingThreshold`), `pose/id-switch-check.js`,
`ui/image-embedder.js` (`createImageEmbedder`, `IMAGE_MODEL_MB`, `formatEmbedTiming`,
`createLoadMeter`, `formatEmbedDevice`),
`ui/id-switch-review.js` (row keys, change-point helpers, `linkIdSwitchResults`,
`idSwitchFixPlan`, `idSwitchFixFor`, `idSwitchRenameForFix`),
`ui/id-switch-highlight.js` (`setIdSwitchHighlight`, `updateIdSwitchHighlight`,
`refreshIdSwitchHighlight`, `ID_SWITCH_SECTION_RGB`).

**Imported by.** `ui/ui-wiring.js` (`#menuCheckSizeSwitches`,
`#menuCheckImageSwitches`, `setIdSwitchNavigator`, `setIdSwitchRefresher`, `updateIdSwitchProgress`), `pose/tracker.js` (the
automatic run, `clearIdSwitchResults`), `ui/info-panel.js` and
`ui/sessions-panes.js` (`refreshIdSwitchPanel`).

**Coverage.** `tests/e2e/size-switch-check.mjs` (size, menu path, the checklist:
ticks, Next unreviewed, persistence across the tab / a re-run / a session switch,
Clear, one scroller),
`tests/e2e/track-auto-size-switch-check.mjs` (after Track All / Track Frame Range),
`tests/e2e/id-switch-image-check.mjs` (images with an injected embedder: "Both"
merge, identical-size animals found by images only, Esc cancel, the progress dialog's
percentage / playhead / GPU line / sample crop and skeleton overlay, no GPU = runs on
the CPU to the end, menu, default off), `tests/e2e/id-switch-fix.mjs` (Fix switch…: both start rules in the
dialog, Esc / Cancel / shortcuts, the swap fixes exactly the crossed stretch, the
row afterwards, the renamed follow-on, saved, Undo exact).

---

### ui/id-switch-review.js

**Purpose.** The ID Switches tab's review checklist as data: the helpers that read
a session's check results (`session._idSwitch`) and their `.slp` serialization,
`metadata.lucid.idSwitchReview`, written and read through
`import-export/visibility-metadata.js` (the one `metadata.lucid` seam).

**Key exports.** `idSwitchRowKey(m)` (check + frame + identity NAMES — names, not
ids, are what a reopened project still agrees on); `idSwitchPrimary(res)` (change
points), `idSwitchMarkers(res)` (+ repeats), `idSwitchOnsets(res)` (the
"possible switches" count), `idSwitchEncounterCount(res)`;
`linkIdSwitchResults(results)` (tag each marker's `cue`, link a size and an image
change point of the same pair within 1 s as `agree` — "Both");
`serializeIdSwitchReview(session)` -> payload or `null` (no check results -> no
key, so untouched projects keep their bytes); `ingestIdSwitchReview(session,
payload)` (rebuilds `session._idSwitch`, re-links "Both"; ignores anything
malformed, never throws); `idSwitchFixPlan(m, res, {currentFrame,
totalFrames, window?})` -> `{key, partnerKey, nameA, nameB, from, to, start
('current' | 'separate'), edge}` or null
— what fixing row `m` swaps (see below); `idSwitchFixFor(st, m)` (the fix covering
a row, its own or its partner's); `idSwitchRenameForFix(st, fix)` (renames the
other pairs' rows inside a fixed stretch — an involution, keys follow).

**What a fix swaps.** The boundary is the CURRENT frame whenever it is inside the
row's window (`o.window` — in the app the whole progress bar, 1 s before the
animals come close to 1 s after they separate), so the user puts it where they saw
the labels flip by playing, stepping or clicking the bar; outside the window it
falls back to e + 1 (where the animals separate). Without `o.window` the window is
the close spell [s, e + 1]. An onset swaps from there to its `switchBackAt` encounter's last
close frame, or the last frame; an 'end' swaps the stretch BEFORE it, from just
after `switchedAt` (or frame 0) to the frame before its boundary. The change point
at the other edge is the fix's `partnerKey` (the same stretch). Results restored
from a file saved before the links existed pair by the nearest change point of
the same pair on the right side. After a fix, every OTHER row in the stretch that
names exactly one of the pair is about the animal that now carries the other
name, so it is renamed (selecting it must still box the same animals); the fixed
pair's own rows are not.

**Format.** `{v: 1, checks: {size?|image?: {encounters, sampleHz, step, fps,
fpsFromVideo, [imageHz, crops, cameras, model: {name, note}], points: [[frame,
nameA, nameB, score (0.1), kind ('' | 'end'), followOf (frame | -1), continues
(0 | 1), startFrame (the encounter's first close frame | -1; absent in files saved
before it existed — they still open, rows then land on the end frame), link
(`switchBackAt` / `switchedAt` | -1 for none; absent in older files)], …]}},
reviewed: [rowKey, …], fixes?: [[key, partnerKey, nameA, nameB, from, to], …]}`
(`fixes` oldest first, only when something was fixed) — only what the tab and the timeline
draw; not the encounters or the fitted models. A restored check result has
`restored: true` and `encounterCount` instead of `encounters`.

**Imports from project modules.** None (loads in the node test sandbox; listed in
`tests/run-node.js`).

**Imported by.** `ui/id-switch-modal.js`, `import-export/visibility-metadata.js`.

**Coverage.** `tests/test-id-switch-check.mjs` (lossless reopen -> re-save,
"Both" re-link, ticks, garbage tolerance, nothing written without results);
`tests/test-id-switch-fix.mjs` (the links, the plans, renaming, fixes round trip);
`tests/e2e/visibility-settings-roundtrip.mjs` (both writers, real reader).

---

### ui/id-switch-highlight.js

**Purpose.** An animated box around the selected ID-switch row's two animals in
every camera view, while the viewer's frame is inside that row's interval (1 s
before they come close -> 1 s after they separate — the row's progress-bar span).

**Key exports.** `setIdSwitchHighlight({nameA, nameB, p0, s, e, p1} | null)`
(`s..e` is the close spell); `updateIdSwitchHighlight(frame)` (every frame
change, via `ui/id-switch-modal.js` `updateIdSwitchProgress`);
`refreshIdSwitchHighlight()` (recompute the boxes at the current frame after the
identities changed — a fix); `getIdSwitchHighlight()`; `ID_SWITCH_SECTION_RGB` (`{lead, close}` as `r, g, b`
strings — orange / red) and `idSwitchSection(target, frame)` (`'close'` over
`[s, e]`, else `'lead'`).

**How.** Draws on its OWN canvas per view (`.id-switch-canvas`, appended to the
view's `.canvas-wrapper`, `pointer-events: none`), backing size video × zoom like
the overlay canvas: the wrapper's CSS transform carries zoom/pan/rotation, the
overlay redraw paths (which clear the overlay canvas every frame) never touch it,
and the overlay-video export does not include it. A `requestAnimationFrame` loop
runs ONLY while the frame is in the interval — the outline marches (dash offset)
and pulses even when paused — and stops after clearing the canvases once outside
it. It is kept cheap because it runs during playback on every view: a view is
repainted when the frame changes and otherwise at most every `ANIM_MS` (33 ms; the
animation is timed from the clock, so its speed does not depend on the rate), and
a repaint clears only the rectangle the previous one drew (`_dirty`) instead of
the whole video-sized canvas — repainting all eight full canvases at the display
rate (120 Hz) was twice the video's own rate. Boxes are recomputed only when the frame changes: per camera, the instances
whose identity NAME is one of the pair at that frame (per-frame track identity
first, then the group's `identityId`; unlinked instances via
`getIdentityIdForUnlinkedInstance`), one box around both (or the one visible),
labelled "id_a ↔ id_b" in the identities' colours. The outline wears the
colour of the row's progress-bar SECTION the frame is in — orange over the
lead-in and lead-out, red over the close spell — from `ID_SWITCH_SECTION_RGB`,
which the bar (`ui/id-switch-modal.js` `progressHtml`) also reads, so the two
cannot drift. Lines, padding and text are
sized in SCREEN pixels (canvas width / (layout width × zoom)), so a small tile
of a large video stays readable. Lazy projects: nothing for a non-resident frame.

**Imports from project modules.** `ui/app-state.js` (`state`), `ui/overlays.js`
(`makeVideoToCanvasTransform`).

**Imported by.** `ui/id-switch-modal.js`.

**Coverage.** `tests/e2e/id-switch-highlight.mjs` (two real views: box around
the pair and not the third animal, animates while paused, orange in the
lead-in / red in the close spell / orange in the lead-out with the bar's
sections matching, the bar's playhead and click / drag seeking, cleared past the
interval and redrawn on return, a moved box leaves nothing behind, Clear stops
it); `tests/e2e/_bench-playback.mjs` scenario `idswitch` (playback cost on a real
project with a row selected over the whole run).

---

### ui/image-embedder.js

**Purpose.** Appearance embeddings for the image ID-switch check: for a sampled
frame and the identities present, decode that frame in every camera
(streamed, and moved to the nearest keyframe when keyframes are dense: see
below), cut a masked, pose-aligned crop of each identity from
its own 2D keypoints, and embed the crops with DINOv2-small — on the GPU, or
without one on the CPU.

**Where the model runs** (`pickImageDevice`, at `createImageEmbedder`): a HARDWARE
WebGPU adapter, else the CPU — no WebGPU, no adapter, or only a software one.
SwiftShader (headless Chromium with WebGPU on; what a VM with no GPU gets) ran
the model at 0.27 crops/s, 10x slower than ONE CPU worker, so it is never used.
**The CPU path** runs the fp32 model on WebAssembly in module workers
(`createCpuModelPool`, `ui/image-model-worker.js`), each with its own model.
Measured on a 12-core M2 Pro, in the browser:
- **Same embeddings.** CPU fp32 vs WebGPU fp32: cosine 1.00000 on every crop
  (vs WebGPU fp16: 0.9997–0.9999). The CPU runtime's DEFAULT model is int8, and
  that is what "drifts from the calibrated embeddings" referred to — the dtype,
  not the device.
- **Off the main thread, or the page freezes.** On it, one run blocks the page for
  its whole duration: 0.33 s for 1 crop, 2.6 s for 8 — the dialog and its Cancel
  stall. onnxruntime's own `wasm.proxy` worker cannot start from the CDN bundle
  ("worker not ready"), so LUCID runs its own. In workers the longest main-thread
  gap was 51 ms.
- **Several workers, because one thread each.** Without cross-origin isolation
  (which GitHub Pages cannot turn on) WebAssembly gets ONE thread. Workers scale:
  1 -> 2.8, 2 -> 5.1, 4 -> 9.7, 6 -> 13.8, 8 -> 14.6 crops/s (GPU: ~150). Each
  costs ~600 MB of process memory (its own model + runtime), so
  `cpuModelWorkerCount` takes half the cores beyond two, at most one per 2 GB of
  `navigator.deviceMemory`, at most `CPU_MODEL_MAX_WORKERS` (4), at least 1.
- The first worker downloads the model (88 MB, reported) and the rest load it from
  the browser cache; a worker that fails to start is dropped. `run(data, n)`
  splits a batch evenly over the workers, in order. `releaseFrames` terminates
  them — they are not kept between runs (reloading is ~1 s from cache).
WebNN is not tried on the CPU path (it is judged against WebGPU). The run
summary says "model busy" and "CPU (N workers) fp32" instead of "GPU busy" /
"WebGPU".

**Speed.** `prepareFrames(frames)` opens one `streamingReader` per camera over the
whole sorted frame list (mediabunny `samplesAtTimestamps`: decode forward once,
instead of `getFrame` re-decoding from the keyframe — up to a 250-frame GOP — for
every sample; falls back to `getFrame` without a mediabunny backend);
`releaseFrames()` closes them. Model runs are serialised on a queue, so the
check's one-ahead request decodes and crops the next frame while the GPU embeds
the current one. `maxViewsPerAnimal` (from `imageCheckMaxViews`) embeds only each
animal's N largest views (`selectViews`, by Nose–TTI pixel length, decided from
the keypoints before decoding); cameras no animal needs are not fetched.
Cropping runs in a pool of module workers (`createCropPool`,
`ui/image-crop-worker.js`; one per core but one, at most 8; one job = one view of
one frame, its VideoFrame transferred and closed by the worker — a decoder-cached
frame is sent as a `clone()`, anything else as an ImageBitmap copy). A failed
worker drops that one view of that frame and the rest of the run crops inline;
`window.LUCID_CROP_WORKERS = 0` forces inline. `writeInputTensor`'s 160 -> 224
sample positions are a precomputed table (same arithmetic, bit-identical).
**GPU feeding (2026-10-04).** On RTX 2000 Ada / RTX 4000 Ada PCs the GPU ran ~50%
busy at ~83 crops/s — below the M2 Pro — because each frame was one small model
call (~15 crops) with the GPU idle between calls. Now: (1) the model's output
stays on the GPU (`preferredOutputLocation: 'gpu-buffer'`; its ONLY output is
`last_hidden_state` [n, 257, 384], 5.9 MB per 15 crops) and `clsFromGpu` copies
just token 0 of each crop into a staging buffer — 1/257 of the readback,
bit-identical (max |difference| 0); (2) model runs are a greedy BATCH QUEUE: one
run at a time, each taking every crop queued meanwhile (up to `EMBED_MAX_BATCH`
= 64), with the check keeping `EMBED_IN_FLIGHT` = 8 frames in flight
(`inFlight` on the provider) so batches fill while the GPU works. M2 Pro, 150
real frames: 104 -> **155 crops/s**, GPU busy 66% -> 98%, batches ~15 -> ~55,
embeddings identical. (3) `stats()` / `summarizeEmbedTiming` /
`formatEmbedTiming`: crops/s, GPU busy % (model call + result wait over wall
time), batches, ms/crop, and per-frame decode / crop / queue latency — logged
to the console and shown under "About these flags", so a slow run says where it
waited (e.g. Drive-streamed video: decode 734 ms/frame, GPU busy 43%), ending
with the backend and precision that ran ("· WebGPU fp16" — fp32 where the GPU
lacks `shader-f16`, ~1.5x slower on an M2 Pro). Field results (5-mouse, 3,375
frames, 8 cameras, 8 in flight): RTX 2000 Ada PC 131 crops/s, GPU busy 92% at
7.1 ms/crop — compute-bound; RTX 4000 Ada VM 161 crops/s, GPU busy 76% at
4.8 ms/crop, decode ~530 ms/frame with its video decoder 44% busy — frame
supply-bound. 16 in flight was tried and reverted: no change (PC 124, VM 160
crops/s; decode is throughput-bound, so each frame just waited twice as long)
while the PC's dedicated GPU memory climbed to 10.6 GB.
**Live, in the progress dialog** (`device()` / `busyMs()` -> `formatEmbedDevice`
+ `createLoadMeter`): which GPU runs the model and how busy the check keeps it.
`gpuAdapterInfo(device, adapter)` names it from the model's own
`GPUDevice.adapterInfo` (onnxruntime's `env.webgpu.adapter` is undefined in this
build; a fresh default adapter is the last resort) — "Apple metal-3" from vendor
+ architecture, since browsers usually withhold `description` — and reads
`isFallbackAdapter`. That flag matters: a SOFTWARE adapter (SwiftShader) is
WebGPU on the CPU, so `pickImageDevice` sends it to the CPU workers, and the line
says "No GPU" in the warning colour instead of a load. The load is the share of the last `GPU_LOAD_WINDOW_MS`
(5 s) spent in model runs, the one in flight included — `gpuBusyPct`, but recent.
No browser API reports a GPU's total utilisation, so other apps' use is not in
it, and its tooltip says so. Real model, M2 Pro, 8 views: 92 -> 99% while
embedding (148 crops/s; whole-run `gpuBusyPct` 98%), then 86 / 63 / 43 / 24 / 4 /
0% at 1 s steps once idle. WebNN is not called a GPU (the browser picks its
device; it measured CPU-only on macOS).
**Decode workers were tried and removed** (2026-10-04). The recordings are HEVC,
P-frames only, a keyframe every 250 frames, so the check decodes essentially
every frame of every camera (~2,000–2,700 decoded frames/s on the field
machines). A per-camera module worker that opened the camera's file with
mediabunny, stream-decoded and cropped there gave bit-identical crops, and the
same throughput as the main thread on an M2 Pro (~4,800 decoded frames/s, the
hardware decoder's limit) — but on an RTX 4000 Ada VM (Windows) it ran at about
half the speed (~4–5 vs ~10.7 frames/s), with the hardware video decoder less
busy (19–26% vs 44%) and dedicated GPU memory climbing in a GC sawtooth to 19.3
of 20 GB. Not reproducible on macOS (no unclosed-VideoFrame warnings), so it was
removed rather than kept as an option. Cheaper decoding has to come from the
recordings (keyframes every 0.5 s).
**Keyframe sampling (2026-10-04).** `prepareFrames` reads each camera's keyframes
from the container's packet index (`keyframeIndices`: mediabunny
`EncodedPacketSink.packets(…, {metadataOnly: true})`, `type === 'key'`, mapped to
frame indices through the backend's `_frameTimes`; no frame data read, cached per
video) and plans the samples with `planKeyframeSamples` (pose/id-switch-check.js):
when the median keyframe gap is <= `KEYFRAME_GAP_TOLERANCE` (1.1) x the sample
spacing (32 frames at 60 fps and 2/s; the 10% lets a recorder's "keyframe every
0.5 s" qualify at frame rates where rounding makes the spacing a little shorter —
49 frames at 100 fps, 24 at 50 — at every rate up to 240 fps), each sample moves
to its nearest keyframe within half of max(spacing, keyframe gap) that has
tracking (`session.instanceGroups.has`), so `samplesAtTimestamps` decodes ONE
frame per sample (mediabunny resets to the target's keyframe when it is past the
last decoded packet). Each view crops its animals from the keypoints of the frame
it actually decoded (`decodedFrame`; the same identity's group there — an
identity seen twice in that frame is left out), while the evidence still counts
at the grid frame, so encounters and tracklets are unchanged. Sparser keyframes
move nothing: the timestamps are exactly the old ones. Per camera, so cameras
encoded differently mix. `opts.keyframes`: `false` (or `window.
LUCID_IMAGE_KEYFRAMES = 0`) turns it off; a function `(decoder) -> keyframe
indices` replaces the index (diagnostics). `stats().keyframes` /
`summarizeKeyframePlans` -> `{cameras, of, snappedPct, keyframeGap, spacing}`, and
the speed line ends "· decoded at keyframes in 8/8 cameras (100% of samples)" or
"· every frame decoded (keyframe every 250 frames; a keyframe every 0.5 s — 35
frames or fewer — would decode only the samples)". Measured on the M2 Pro, 2-minute clips of the 8 cameras of the
5-mouse recording decoded concurrently (`tests/e2e/_bench-image-keyframe-decode.mjs`,
1,800 camera-samples): original files and x265 with a keyframe every 250 frames
151 samples/s (53,768 frames decoded, ~4,500/s — the hardware decoder's limit);
x265 with a keyframe every 30 frames 297 samples/s in place (27,000 frames:
mediabunny already skips to each sample's GOP) and **2,800 samples/s snapped
(1,800 frames) — 18.6x today**. On that HEVC (hardware decoder) a keyframe decoded
alone is bit-identical to it decoded mid-stream (96/96 raw planes; embeddings of
the same crops max |difference| 0). Cost of the keyframes (x265, same QP 24, P-only):
+42% file size over the 8 cameras (+30% to +65% per camera; the static views pay
most), at slightly HIGHER quality vs the original (PSNR +0.6 to +0.75 dB on every
camera, SSIM up ~0.0015); on camera 0, QP 26 restores the size at -0.35 dB.
The field recordings come from campy's NVENC writer (`-preset fast -qp 24 -bf:v
0`, no `-g`, so NVENC's default keyframe every 250 frames); from those files'
own keyframe / P-frame sizes, a keyframe every 30 frames at QP 24 projects to
+53% (+43% to +70% per camera; 6.3 -> ~9.7 GB per 30-min 8-camera session).
**AV1** (campy's `av1_nvenc` setups) works the same way: keyframes from the
packet index, one decoded packet per sample, bit-identical keyframes (96/96,
embeddings max |difference| 0). It costs more: SVT-AV1 (low-delay, CRF 32) +95%
size for a keyframe every 30 frames; and on the M2 Pro, which has no AV1
hardware (Chrome decodes it in software), it is only 2x faster: 140 samples/s
today -> 272 snapped (134 in place; software AV1 keyframes are expensive). GPUs
with AV1 decode (RTX 30/40, Ada) should look like the HEVC case; not measured.
Embeddings are bit-identical across all of this (cosine 1.00000 vs seeking,
top-k vs the same views at all-k, and max |difference| 0 for worker vs inline
crops over 5,687 real crops).

**WebNN (opt-in, experimental: `webnn: true`, from `imageCheckWebNN`).** WebNN can
reach hardware WebGPU cannot — on Windows, Chrome runs it through Windows ML /
DirectML, which use NVIDIA tensor cores. It is behind
`chrome://flags/#web-machine-learning-neural-network` (Chrome 154), compiles a
static graph (input fixed to `WEBNN_BATCH` = 8 crops via `freeDimensionOverrides`,
the last batch zero-padded), and its numerics are not the calibrated model's. So
the first `WEBNN_TRIAL_FRAMES` (6) frames are embedded on BOTH backends — WebGPU's
output is what the check uses — and `chooseBackend` keeps WebNN only if it is
>= 10% faster and agrees (median cosine >= 0.998, worst >= 0.98); it stops early
once WebNN runs at under half WebGPU's speed. Any WebNN failure falls back to
WebGPU. `backend()` -> `{name, note}` says what happened. Measured on the M2 Pro
(the only hardware tested): WebNN runs the whole graph (652/652 nodes on the WebNN
EP) but on the CPU whatever the device hint, `powerPreference` or the
`WebNNCoreML*` features — raw matmuls 0.29 TFLOPS, the model 14 vs 140 crops/s —
so the trial keeps WebGPU (results identical, +3.4 s). Forced WebNN (`webnn:
'force'`, benchmarking only) agrees with WebGPU: cosine median 0.9994, worst 0.997.
**Windows / NVIDIA RTX 2000 Ada (2026-10-04, Chrome with the WebNN flag): the
trial picked WebNN — 435 vs 180 crops/s (2.4x, the tensor cores via Windows ML),
embeddings agree (cosine 0.9992); the same 8 image switches as the WebGPU run.**
The whole check went 124–131 -> 151 crops/s (386 -> 335 s): with the model
that fast the run is decode-bound (decode 608 ms/frame, queue 4 ms, the video
decoder 83% busy). WebNN model runs are timed into the speed line (they return
results on the CPU, so run + readback are one figure). Workers: 9-16% faster on an M2 Pro (model-bound
there), main thread blocked 0.1 s instead of 10-24 s per 150 frames, and the
decode + crop ceiling rose from 145 to ~270 crops/s at 3 views (decoding alone:
7.9 s vs 8.3 s with cropping) — headroom for a GPU faster than ~145 crops/s.
Numbers in `ui/id-switch-modal.js`.

**Key exports.** `createImageEmbedder(session, {onStatus, maxViewsPerAnimal, webnn, keyframes})` ->
`{getEmbeddings, prepareFrames, releaseFrames, backend, device, busyMs, stats, inFlight, views}` (the provider
`checkImageSwitches` needs; `releaseFrames` also terminates the crop pool and the
CPU model workers and disposes a WebNN model; `device()` -> `{backend: 'webgpu'|'webnn'|'cpu',
comparing, dtype, adapter, fallback, workers, why}` and `busyMs()` feed the progress
dialog's device line, `sampleCrops()` its sample crop: `[{tensor, frame, camera,
identityId, points}]` (`points` from `cropPointsToInput`), one per frame rotating through its animals and cameras, the last
`SAMPLE_CROPS` kept as REFERENCES (nothing is converted unless the dialog asks).
Several rather than the latest because on the CPU frames arrive in bursts — 8 cut
at once, then ~6 s of model time — and one latest crop sat still between them); `opts.device` ('auto' | 'webgpu' | 'cpu') and `opts.cpuWorkers`
force a device / worker count (tests, benchmarking);
`pickImageDevice()` -> `{kind: 'webgpu'|'cpu', adapter, why}`; `cpuModelWorkerCount(cores, memoryGB)`,
`CPU_MODEL_MAX_WORKERS`; `createCpuModelPool(count, onStatus)` -> `{size, run(data, n) ->
Promise<Float32Array[]>, terminate()}`;
`loadImageModel(onStatus)` (WebGPU; once, cached promise);
`selectViews(geos, maxViews)`; `EMBED_MAX_BATCH`, `EMBED_IN_FLIGHT`,
`summarizeEmbedTiming(tm, backend, dtype)`, `formatEmbedTiming(t)`;
`describeAdapter(info)`, `gpuAdapterInfo(device, adapter)` -> `{name, fallback}`,
`createLoadMeter(windowMs)` -> `(now, busyMs) -> pct|null`, `GPU_LOAD_WINDOW_MS`,
`formatEmbedDevice(device, load)` -> `{text, warn, title}`; `inputTensorToPixels(tensor, rgba)`
(a model input back to grey RGBA, the inverse of `writeInputTensor`'s normalisation),
`SAMPLE_CROPS` (12); `cropPointsToInput(g)` (`g.pts`, the keypoints `cropGeometry` now also
records, NaN when missing, into model-input pixels: cutCrop's rotate-about-the-body-centre
and scale, then x 224/160 — which is exact for an align_corners=false resize; pinned
against `cutCrop` itself within 0.04 px, at any rotation);
`keyframeIndices(decoder)` -> `Promise<Int32Array|null>` (cached per video);
`summarizeKeyframePlans(plans)`; WebNN: `hasWebNN()`, `loadWebNNModel(onStatus)`,
`chooseBackend(trial)`, `WEBNN_BATCH`, `WEBNN_TRIAL_FRAMES`; `createCropPool()` -> `{run(image, crops) ->
Promise<Float32Array[]>, broken, terminate()}` or null; crop helpers
`cropGeometry` (now also `pts`: every keypoint, for the overlay — cutCrop ignores it), `cutCrop`,
`convexHull`, `writeInputTensor`, `skeletonIndex(nodes)` (now also `n`, the node count),
`frameCropGeometry(session, frame, items, cams, atFrames, sk)` -> `geo[view][item]`; constants
`TRANSFORMERS_URL`, `IMAGE_MODEL_ID`, `IMAGE_MODEL_MB`, `CROP` (160), `INPUT` (224).

**The crop** (must match the calibration): rotate so the nose points right
(Nose − TTI), centre on the mean of the body keypoints, side 1.3 x body length,
160 x 160, greyscale; outside the animal's convex hull dilated by a quarter body
length is black, and so are the other animals' hulls in that view; resized to
224 (bilinear) and ImageNet-normalised; embedding = CLS token of
`last_hidden_state` (post-layernorm). Checked against the offline pipeline on 24
real crops: pixel correlation 0.994 (median), 99% mask agreement; embeddings
cosine 0.971 (vs 0.644 between different crops).

**Crop geometry on a lazy project: `frameCropGeometry`.** The geometry comes from
group members' 2D, for frames the check never makes resident — and on a lazy
project those members hold no 2D (a reopened project's placeholders never had
it; a Track All's are given back to the store as each window is released —
`pose/lazy-residency.js`). Read directly, every such member yields no geometry,
so the check embedded nothing there. `frameCropGeometry` hydrates the members of
each frame it reads (the sampled frame and any keyframe-snapped `atFrames`) with
`hydrateFrameMembers2d`, computes the geometry, and gives the 2D back with
`releaseFrameMembers2d` — so the check costs no residency and leaves nothing
inflated.

**Dependencies.** transformers.js **pinned to 4.3.0** (`/+esm` from jsdelivr —
pinned for the reason dockview is) and `onnx-community/dinov2-small` from the
Hugging Face CDN, both fetched on FIRST USE and cached by the browser; nothing
about the user's data is sent. fp16 (~44 MB) when the GPU has `shader-f16`, else
fp32 (~88 MB). WebGPU only: the CPU (WASM) runtime measured ~50x slower (3 vs 155
crops/s) and its int8 model drifts (cosine 0.953 vs the calibrated model). Re-check
the CLS extraction (`last_hidden_state` token 0) on any version bump.

**Imports from project modules.** `ui/app-state.js` (`state.views`),
`pose/id-switch-check.js` (`planKeyframeSamples`, `KEYFRAME_GAP_TOLERANCE`),
`pose/lazy-residency.js` (`hydrateFrameMembers2d`, `releaseFrameMembers2d` — DOM-free,
so the crop worker can load it); `mediabunny`
(`EncodedPacketSink`, imported LAZILY inside `keyframeIndices` — a static bare
import would break this module in Node tests and in the crop worker, which has no
importmap). Spawns `ui/image-crop-worker.js`.

**Imported by.** `ui/id-switch-modal.js`, `ui/image-crop-worker.js`.

**Coverage.** Crop geometry, `selectViews`, `chooseBackend`, the resize table and
the keyframe line of `formatEmbedTiming` in
`tests/test-id-switch-check.mjs`; `frameCropGeometry` on a released member (with
the direct-read control that finds nothing) in `tests/test-lazy-residency.mjs`; the crop pool in `tests/e2e/image-crop-worker.mjs`;
keyframe sampling on generated 60 fps H.264 and AV1 (keyframes every 30 frames vs one) in
`tests/e2e/image-keyframe-sampling.mjs` (keyframe index, one decoded packet per
sample, bit-identical planes, sparse video unchanged); accuracy on real data by
`tests/e2e/_diag-image-keyframe-snap.mjs` (diagnostic, not in the suite);
the full path on real data by a scratch harness (not in the suite: it needs the
proofread videos and GPU) — see the image-check notes above.

---

### ui/image-crop-worker.js

**Purpose.** Module worker that cuts the image ID-switch check's crops off the
main thread, for `createCropPool` in `ui/image-embedder.js`. It runs the same
`cutCrop` + `writeInputTensor` the main thread would, so its output is
bit-identical (asserted).

**Messages.** IN `{id, image: VideoFrame|ImageBitmap (transferred), crops:
[{g: cropGeometry, others: [hull]}]}` — one camera view of one frame; OUT `{id,
tensors: [Float32Array(3 x 224 x 224)]}` (transferred, one per crop, in order) or
`{id, error}`. The worker owns the image and closes it.

**Imports from project modules.** `ui/image-embedder.js` (`cutCrop`,
`writeInputTensor`, `CROP`, `INPUT`; that module's only import, `ui/app-state.js`,
is worker-safe).

**Spawned by.** `ui/image-embedder.js` (`createCropPool`).

**Coverage.** `tests/e2e/image-crop-worker.mjs`.

---

### ui/image-model-worker.js

**Purpose.** Module worker that runs the image ID-switch check's model on the CPU
when there is no hardware GPU: DINOv2-small at **fp32** on WebAssembly (the
default int8 is what drifts from the calibration; fp32 equals the WebGPU fp32
model, cosine 1.00000). Off the main thread because there a run blocks the page
for its whole duration (2.6 s for 8 crops); several run side by side because
WebAssembly gets one thread without cross-origin isolation. See
`ui/image-embedder.js` ("The CPU path") for the measurements.

**Messages.** IN `{type: 'load'}` -> `{type: 'loaded'}` (while downloading:
`{type: 'progress', loaded, total}`) or `{type: 'error', message}`; IN `{type:
'run', id, data: Float32Array(n x 3 x 224 x 224) (transferred), n}` -> `{type:
'result', id, cls: Float32Array(n x 384) (transferred), dim}` — each crop's CLS
token, read exactly as the main thread's `clsVectors` does — or `{type: 'error',
id, message}`.

**Imports from project modules.** `ui/image-embedder.js` (`TRANSFORMERS_URL`,
`IMAGE_MODEL_ID`, `INPUT` — so the pin stays in one place), then the runtime from
`TRANSFORMERS_URL` (a dynamic cross-origin import, which a module worker may do).

**Spawned by.** `ui/image-embedder.js` (`createCpuModelPool`).

**Coverage.** `tests/e2e/image-check-cpu.mjs` (the real model in headless Chromium,
which has no GPU: vectors bit-identical to the main thread's per animal and camera,
a responsive page, worker teardown, and the real dialog — the after-tracking path —
running instead of refusing); `tests/e2e/id-switch-image-check.mjs` §4 (the dialog
with no GPU runs to the end and finds the switch).

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
handler elsewhere and listed for reference only. The two **mouse gestures** on
an instance — `moveInstance` (`Alt+Drag`) and `rotateInstance` (`Alt+Wheel`,
issue #198) — are in the catalog for the same reason: they have no key to
rebind, so they are reference-only, but they belong in Settings ▸ Keyboard
Shortcuts and the Hot Keys modal where people look for them.

**Key exports.**
- `getDefaultTriangulationMethod()` / `setDefaultTriangulationMethod(method)` —
  read/write the default method used by implicit triangulation paths.
- `onDefaultTriangulationMethodChange(fn)` — called with the new method when
  `setDefaultTriangulationMethod` actually changes it (a throwing listener is
  ignored). `ui/ui-wiring.js` uses it to keep the toolbar's "Triangulate: DLT"
  / "Triangulate: Ref" labels in step with Settings (#138).
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
  wizard's render catalog `[{ id, label, default, value, min, max, step, desc, kind }]`
  (`kind`: `'toggle'` for on/off settings, drawn as a switch; else `'number'`),
  **filtered to `WIZARD_THRESHOLD_IDS`** — the CrossViewTracker's free parameters
  only (`filterMinVisibleNodes`, `filterMinInstanceScore`, `corr2dWeight`,
  `corr3dWeight`, `velocityThreshold`, `distanceThreshold`, `timePenalty`,
  `stale`, `matchGate` (0/1 toggle for the CrossViewTracker match gate),
  `reprojErrorThreshold`, `autoSwitchCheck` — 0/1, run the body-size ID-switch
  check after Track All / Track Frame Range, default 1; `autoImageSwitchCheck` —
  0/1, the image check likewise, default 0; `imageCheckThreshold` -25;
  `imageCheckHz` 2; `imageCheckMaxViews` 3; `imageCheckWebNN` — 0/1, try WebNN,
  default 0). The remaining catalog entries (`epipolarDecay`, `reprojSigma`, `epipolarWeight`,
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
  its handler (skipped when `shouldIgnoreShortcut(e)` says the key belongs to
  the focused control); returns `true` if handled. Supports
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

**Imports from project modules.** `ui/keyboard-target.js` (the focus guard
`dispatchEvent` applies). That module imports nothing itself, so this one stays
bridgeable.

**Imported by.** `ui/ui-wiring.js`, `ui/identity-assignment.js`,
`ui/settings-modal.js`, `pose/tracker.js`.

---

### ui/settings-modal.js

**Resizable, draggable, and it remembers.** The card carries CSS `resize: both`
and is dragged by its header (minus the ×, via `noDragSelector` — dragging from
a button that is about to be clicked would be a trap); `installModalGeometry`
(`ui/modal-geometry.js`, id `settings`) restores the last size/position on open
and records the new one on close. It is installed AFTER the overlay is appended,
because with nothing remembered the card is centred at whatever size the
stylesheet gave it, which can only be measured once it is laid out.

**The wizard's tables grow; they do not scroll.** Node Weights and Camera Views
used to be 240px boxes with their own `overflow-y: auto` — a scrollbar inside
`.settings-panel-container`'s scrollbar, so the wheel did different things a few
pixels apart and rows past the cap were invisible with no hint that the window
could be made taller, because it could not. Each of the three wizard sections is
now a `<details>` built by `buildSection(title, count)`, and the tables render
every row. `.settings-panel-container` is the ONE scroller in the card. Widening
the (now resizable) modal reflows the `auto-fill minmax(220px, 1fr)` grid into
more columns, which is what actually makes a long skeleton fit; folding a
section away is what keeps the rest of the wizard reachable. See the
no-scroll-within-scroll convention in CLAUDE.md.

`<details>`/`<summary>` rather than a hand-rolled div + click handler, so the
disclosure is keyboard-operable and screen-reader-labelled for free — and
`ui/keyboard-target.js` already knows a `SUMMARY` owns Space/Enter.

**Purpose.** Builds and shows the "Settings" modal (opened from Help ▸
Settings). Wizard-style layout: a left nav (`settings-nav`) of categories and a
right panel area (`settings-panel-container`), with a Cancel / Apply footer.

**Key exports.**
- `showSettingsModal(initialPanel)` — `initialPanel` ∈ `'triangulation'` |
  `'keyboard'` | `'wizard'` (default `'triangulation'`). Single-instance.

**Behavior.** Three panels: **Default Triangulation** (single-select DLT /
Refined radio rows — the `'ba'` method is labelled "Refined (Ref)" — initialized
from `getDefaultTriangulationMethod()`), **Keyboard
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
Views** — one row per camera of the active session with an on/off switch
(the app's `.toggle-switch`, `role="switch"`; stored as a `0/1` weight) seeded
from `getCameraWeight(name)`; off excludes that view from tracking and greys the
row, with a hint when no cameras are loaded; and **Tracking Thresholds** — one
labelled+described number field per `getTrackingThresholdDefs()` entry (the
CrossViewTracker's free parameters only; legacy luc3d thresholds are filtered
out), range/step from the catalog — or, for a `kind: 'toggle'` entry (the match
gate, the two after-tracking ID-switch checks, the WebNN opt-in), an on/off
switch stored as `1`/`0` (`makeToggle`). Covered by
`tests/e2e/settings-wizard-toggles.mjs`. All edits mutate a local `working`
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

**Playback playhead fast path.** `setCurrentFrame(frameIdx, { playback: true })`
(passed by `ui/rendering.js` only while `state.isPlaying`) does not repaint the
timeline: the playhead is the only frame-dependent layer, so `redraw()` — while
`_playbackMode` is set — snapshots the canvas just before drawing the playhead
into `_staticCache`, and later playback calls blit that snapshot and draw only
the playhead (`_drawFromStaticCache`). A full redraw on the 175-track HardFight
project cost ~4.5 ms plus a forced style recalc (`ctx.font`) inside the
video-frame callback, enough to drop video frames (`tests/e2e/_bench-playback.mjs`).
Falls back to a full redraw when the visible window scrolls or the backing store
changed size; any other `redraw()` (hover, resize, data change) re-snapshots, so
the cache is always the last full redraw. A call WITHOUT the flag leaves playback
mode, frees the snapshot and redraws in full even on the same frame (the
`stopPlayback` settle call). Pixel-parity guarded by
`tests/test-timeline-playback-playhead.js`.

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
  `setCurrentFrame(frameIdx, opts?)`, `setTotalFrames(n)`, `setZoom(level)`,
  `scrollTo(frameIdx)`, `resize`, `redraw`, `destroy`,
  `setDisplayMode(mode)`, `refreshTracks(session, opts?)`,
  `setFrameModified(frameIdx, modified)`, `getPreferredHeight`,
  `getCameraGroups`, `getLabelLines`, `getRowCount`,
  `getTrackAreaElement`.

**Possible-ID-switch markers** are no longer drawn here — they moved to the
transport seekbar (`ui/seekbar-markers.js`); the timeline's marker layer, its
`setSwitchMarkers` / `getSwitchMarkers` API and tooltip text are gone.

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

**ID Timeline and TRACKLESS ungrouped instances.** Pass 1 of
`_buildIdentitySegments` resolves each unlinked row with
`session.getIdentityIdForUnlinkedInstance(cam, instance, frameIdx)`, not the
track-keyed `getIdentityIdForTrack`. A trackless ungrouped instance keeps its
identity on the instance (`Instance.identityId`, stamped by `unlinkGroup` —
`frameIdentityMap` is keyed by trackIdx and a null track has no key; luc3d
#201), and asking by track reads the shared per-camera "-1" slot instead. Every
trackless ungrouped detection was therefore missing from the ID Timeline while
the canvas drew and named it and the Ungrouped Instances table listed its ID.
The unlinked resolver delegates to the track-keyed one whenever a track exists,
so tracked rows are unchanged. Regression test:
`tests/test-timeline-tree-grouping.js` "a TRACKLESS ungrouped instance appears
in the ID timeline via its retained identity" (confirmed to fail pre-fix). The
same track-keyed-resolver-on-an-unlinked-row slip was fixed in three sibling
call sites: `ensureGroupsFromIdentities` (`pose/triangulation.js`),
`groupByIdentityAndTriangulateAll` (`ui/export-modals.js`) — where it meant a
regroup-by-identity could not put back what an ungroup took apart — and
`_identityMatches` (`ui/custom-delete-ops.js`).

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
- `toggleTimeline`, `collapseTimeline`, `fitTimelineToData`,
  `syncTimelineToggleButton`, `installTimelineShortcuts`,
  `getCachedTimelineHeight`, `setCachedTimelineHeight`.
- `collapseTimeline()` closes the timeline only if it is open (never opens
  it), via `toggleTimeline()` so the height cache and toolbar button match a
  manual collapse. Returns whether it collapsed anything.

**Imports from project modules.**
- `./app-state.js` — `state` (for `state.timeline`).

**Imported by.** `pose/initialization.js`, `pose/tracker.js`
(`collapseTimeline`, after Track All), `ui/ui-wiring.js`
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

### ui/track-range-modal.js

**Purpose.** The **Track Frame Range** dialog (#212) — the start/end picker
behind the Track Frame split button's hover dropdown. Exists so tracking can be
re-run over a narrow window around a known ID switch while iterating on Tracking
Wizard settings, instead of re-running a whole long recording.

**Key exports.**
- `showTrackRangeModal()` — builds the modal (standard
  `.multi-frame-modal-overlay` / `.multi-frame-modal` markup), validates
  inline, and on **Continue** calls `trackFrameRange(start, end)`
  (`pose/tracker.js`), which owns the loading overlay and the status line from
  there. Cancel, `Esc` and a backdrop click all close it with no side effects.

**Imports from project modules.** `ui/app-state.js` (`state`,
`getActiveSession`), `import-export/save-load.js` (`setStatus`),
`pose/tracker.js` (`trackFrameRange`, `trackableFrameBounds`,
`getTrackerNumAnimals`, `setTrackerNumAnimals`).

**Imported by.** `ui/ui-wiring.js` (wires `#tbTrackFrameRange`, the dropdown
item; the `#tbTrackFrame` button itself stays wired to `trackCurrentFrame` in
`pose/tracker.js`'s own IIFE). It sits between `ui-wiring.js` and `tracker.js`,
which `ui-wiring.js` already imported directly — so it introduces no new cycle.

**User-facing features.** A **dual range slider** over the session extent
(the same `.range-slider-container` markup as Export Video Overlays' "Choose
Frames for Triangulation"), two-way bound to Start frame (pre-filled with the
current frame) and End frame (pre-filled to a 100-frame window, clamped to the
project), plus **Animals** (pre-filled with the current count; blank =
auto-detect). A live summary line reports the range size and the effective
animal count; a live error line explains an invalid range and disables Continue
rather than closing on bad input. `Enter` is Continue and `Esc` is Cancel, per
the app-wide modal convention. On a successful run the viewer is parked on the
**last frame tracked**, so the run ends looking at its own result.

**Notes / caveats.**
- **It collects the animal count on purpose.** `pose/tracker.js` otherwise asks
  with a native `prompt()`, which would pop up ON TOP of this dialog the first
  time anyone used it. `runTrackingPass` skips that prompt on the range path, so
  a blank Animals field here is an explicit "auto-detect" — and the field is
  written through on every Continue, so clearing it really does turn
  auto-detect back on instead of silently keeping the old count.
- **The range is tracked in isolation.** A range run restarts the tracker at its
  first frame with no history from before it, which the modal's body text says
  outright — identities inside the range need not line up with the frames around
  it. See `runTrackingPass` in `pose/tracker.js`.
- **Frame numbers are 0-based inside, 1-based on screen.** Every frame number
  LUCID shows is 1-based (the `#currentFrame` readout is `frameIdx + 1`, so are
  the copy/paste status lines and Export Video Overlays' range modal); every
  index it stores is 0-based. This modal first shipped showing raw indices, so
  it was the one dialog disagreeing with the transport by one. `toDisplay` /
  `toIndex` hold both conversions and `readForm` is the single crossing point:
  the number inputs and the endpoint labels carry DISPLAY values, the range
  sliders and `bounds` carry indices. `pose/tracker.js` has its own
  `displayFrame()` for the matching status strings.
- **The slider spans `[bounds.min, bounds.max]`, not `[0, max]`.** A sparse
  non-lazy project starts at its first labelled frame, not 0, so
  `updateSliderFill` takes percentages across the real extent; assuming 0 would
  misplace the bar on exactly those projects.
- **Neither thumb may pass or drag the other.** The two share one track, so a
  drag can carry one past the other; each STOPS at the other instead. It briefly
  pushed the other thumb along, which silently moved an endpoint the user had
  already set — dragging start rightwards dragged end with it and quietly
  extended the range. Typed input is handled differently on purpose: an
  inverted range there is reported ("The end frame must not be before the start
  frame.") and disables Continue, rather than silently rewriting what was typed.
- **`onTracked` is injected, not imported.** The navigator (`navigateToFrame`)
  lives in `pose/initialization.js`, which imports `ui/ui-wiring.js`, which
  imports this module — importing it here would close that loop. `ui-wiring.js`
  already holds both ends and passes it in, so this module stays a leaf. It
  parks the viewer using the range `trackFrameRange` REPORTS, not the typed
  values, since the request is clamped to the project extent and reversed input
  is normalized.
- **This modal is why `--accent-color` is now defined.** Six declarations
  referenced it and nothing ever defined it; an undefined custom property is
  invalid at computed-value time, which resolves to the property's INITIAL
  value rather than falling back to an earlier declaration — so
  `.range-slider-fill` and every `.multi-frame-modal button.primary` painted
  `transparent` (measured). Adding this slider would have inherited the
  invisible fill, so `:root` now aliases `--accent-color: var(--accent)`, which
  also repairs the Export Video Overlays slider and every modal primary button.
- Covered by `tests/e2e/track-frame-range.mjs` (phase 4 drives the real toolbar
  dropdown → modal → Continue → loading overlay; phase 5 covers the slider, its
  two-way binding, thumb crossing, the painted fill, and the park-on-last-frame
  behaviour).

---

### ui/trail-presets.js

**Purpose.** Node-trail lengths, in SECONDS — the presets Off, ¼ s, ½ s, 1 s, 2 s, and
any custom length typed into Tracks ▸ Node Trails ▸ Custom…, in seconds or in
frames — and their
conversion to the frames a trail draws. A fixed frame list (it was
10/50/100/250/500) meant something different on every camera: 50 frames is ½ s of
a 100 fps recording and nearly 2 s of a 30 fps one. DOM-free and import-free, so
`ui/app-state.js` can import it and `tests/test-trail-presets.mjs` runs it in Node.

**Key exports.**
- `TRAIL_PRESETS` — `{key, seconds, name}` per preset; `key` names the Tracks ▸
  Node Trails item ids (`menuTrails<key>`).
- `trailFrames(seconds, fps)` — `round(seconds × fps)`, at least 1 for a trail
  that is on, at most `MAX_TRAIL_FRAMES`; 0 when off. 15/30/60/120 at 60 fps,
  25/50/100/200 at 100 fps.
- `trailRate(fps)` — `fps`, or 30 while none is known (`state.fps` is 0 before a
  video loads), so a trail is never silently 0 frames.
- `trailPresetFor(seconds)` — the preset of exactly that length, or null (custom).
- `trailSecondsName(seconds)` — the preset's name, or a custom length in seconds
  to at most 3 decimals ("1.5 seconds").
- `trailLabel(seconds, fps)` — "½ second (30 frames)", "1.5 seconds (90
  frames)", or "Off". The menus, the button's tooltip and the status line all
  use it.
- `parseTrailSeconds(text)` — the Custom… Seconds field: a plain decimal above 0
  (a decimal comma is accepted, since the field is text), else null.
- `parseTrailFrames(text)` — the Custom… Frames field: a whole number of at
  least 1, else null.
- `formatTrailSeconds(seconds)` — how the Seconds field shows a length: at most
  3 decimals, no trailing zeros ("0.167").
- `trailSecondsForFrames(frames, fps)` — how a length typed in frames is stored:
  `frames / fps`, EXACTLY (10 frames at 60 fps is 1/6 s, not 0.167), so it draws
  the frames typed. The unit test round-trips 1–500 frames at 24–250 fps.
- `MAX_TRAIL_FRAMES` (500) — `LAZY_KEEP_BEHIND` (512) must stay above the longest
  trail, since trails draw resident frames only; without the cap a 2 s trail on a
  300 fps recording would be 600 frames, so from 250 fps up 2 s draws 500. The test asserts the inequality.

**Imports from project modules.** None.

**Imported by.** `ui/app-state.js`, `ui/ui-wiring.js`.

### ui/track-summary.js

**Purpose.** What the Track All summary box says, DOM-free so the decision tree is
unit-tested in Node (`tests/test-track-summary.mjs`). Track All used to end on a
status line, plus the ID Switches tab when the automatic check found something;
when it found nothing — or never ran — there was no visible next step, and the
three cases read alike.

**Key exports.**
- `summarizeTrackedIdentities(session, {frames, animals, animalsAuto, elapsedMs, fps})`
  — frames per identity, frames with any identity, frames with every animal, from
  `session.instanceGroups` (never evicted on a lazy project, so the whole project).
  An identity listed twice in one frame counts once.
- `describeSwitchCheck(enabled, res, identities, whyNotRun)` — one check's outcome
  as `{state, switches, encounters, reason, elapsedMs}`, state one of `found` /
  `clear` / `skipped` / `failed` / `cancelled` / `off` / `na` (one identity).
  Switches are `idSwitchOnsets` — the "possible switches" count the tab uses.
- `planTrackSummary(summary, checks)` — the rows, the notes, the next step and the
  buttons. Recommends **Review switches** when any check found one; **Triangulate
  All** otherwise (with "Check by images…" / "Check by body size" offered when that
  check did not run, and a caveat that body size cannot separate similar-sized
  animals when only size came back clear); **Tracking Wizard…** when nothing was
  matched. A skipped check never gets a "nothing found" headline. Notes flag more
  (or fewer) identities than animals.
- `formatShare(count, total)` — floored to one decimal, so only a full count reads
  "100%". `formatDuration(ms)` — "0.4 s", "42 s", "3 min 5 s", "1 h 12 min".
- `formatTrackingSpeed(frames, ms, recordingFps)` — the Tracking time row's detail:
  frames tracked per wall-clock second ("300 fps") and, when the recording's rate
  is known, how many times faster than real time ("10×" for 30 min of video
  tracked in 3). The multiplier is the throughput over the recording fps, so the
  two cannot disagree; with no rate only the fps is shown.
- `MAX_IDENTITY_ROWS` (12) — identity rows listed before "and N more" (the modal
  gets no inner scroller).

**Notes / caveats.**
- **A time is shown only for a check that spent real time** (found / clear /
  failed / cancelled); a skip returns at its preflight.
- **Long reasons are cut at their first parenthesis** (the skeleton skip lists 16
  bone pairs); the row carries the whole reason as `full`, which the modal puts in
  the row's tooltip.

**Imports from project modules.** `ui/id-switch-review.js` (`idSwitchOnsets`,
`idSwitchEncounterCount`), itself import-free.

**Imported by.** `pose/tracker.js`, `ui/track-summary-modal.js`.

### ui/track-summary-modal.js

**Purpose.** The box that opens when Track All finishes: identities, frames
tracked, frames with every animal, tracking time with its speed (fps, × real
time), a bar per identity, each
ID-switch check's result and time, and the **Next step** with its button focused.
Renders `planTrackSummary` (`ui/track-summary.js`) and nothing else.

**Key exports.** `showTrackSummaryModal(summary, checks)` — returns
`{close, overlay}`, or null without a DOM (Node harnesses run Track All).

**Notes / caveats.**
- **A note, not a prompt.** Nothing changes until a button is pressed; Close,
  `Esc` and a backdrop click dismiss it. Each action button clicks the existing
  control — `#tbTriangulateAll`, `#menuCheckImageSwitches`,
  `#menuCheckSizeSwitches`, `#menuTrackingWizard` — so it runs exactly what the
  user would have run by hand (a disabled button, e.g. under Defining Plane Mode,
  ignores it the same way). **Review switches** opens the ID Switches tab and
  presses `#idSwitchNext`, landing on the first flagged switch.
- **Keys stop at it** (capture-phase listener, as `openFixDialog` does), so the
  app's shortcuts do not act under it; `Enter` / `Space` still press the focused
  primary button.
- **One at a time.** A second Track All closes the first box before opening its
  own.
- **No inner scroller.** The identity list is capped instead; the modal itself
  caps its height at the viewport. It drops `.multi-frame-modal`'s 420px
  `min-width` so it fits a narrow window.

**Imports from project modules.** `ui/track-summary.js` (`planTrackSummary`),
`ui/id-switch-modal.js` (`openIdSwitchPanel`).

**Imported by.** `pose/tracker.js`. No cycle: neither import reaches back to the
tracker.

**Coverage.** `tests/e2e/track-all-summary.mjs` — the real Track All button, the
rows and times, the key swallowing and `Esc`, `Enter` running Triangulate All,
replacement on a second run, no box after Track Frame Range, the nothing-tracked
case, and Review switches landing on the first switch. Tests that click the app
after a Track All close the box first (`#trackSummaryClose`).

### ui/view-align-modal.js

**Purpose.** The **Align Views to References** dialog (#226), opened from View ▸
"Align Views to References…" (`#menuAlignViews`). The user ticks two or more
views they have already rotated (Visibility ▸ Video Rotation or the Shift+R+←/→
chord); every other view is rotated to match, from the calibration
(`pose/view-align.js`).

**Key exports.** `showAlignViewsModal()`.

**Behaviour.**
- A table of the session's calibrated cameras: reference checkbox, current
  angle, and a live preview of the angle each will get (or why it is left
  unchanged). Inline errors (fewer than two references, an upside-down
  reference) disable Apply. Pre-selects the last references used, else the
  views already turned when there are at least two. `Esc`, Cancel and a backdrop
  click close with no change; `Enter` applies.
- **Writes both rotation copies**, as every rotation edit does: the session
  store (`setSessionRotation`, persisted in `metadata.lucid.videoRotation`) and,
  for the active session, `view.rotation` + `applyZoom` + `syncRotationUI`. Then
  one `drawAllOverlays` and `markDirty`. Angles are stored as whole degrees.
- **"Also apply to the other N sessions"** re-solves each other session from
  its OWN calibration with this session's reference angles; sessions missing a
  reference camera are listed in the status line, never half-applied. Edited
  background sessions get `isDirty = true` directly — `markDirty()` only flags
  the active one, and the switch-away prompt and lazy eviction read each
  session's own flag.

**Imports from project modules.** `ui/app-state.js` (`state`,
`videoController`, `getActiveSession`), `import-export/save-load.js`
(`setStatus`, `markDirty`), `ui/rendering.js` (`drawAllOverlays`),
`ui/sessions-panes.js` (`syncRotationUI`), `ui/video-filters.js`
(`getSessionRotation`, `setSessionRotation`, `clampRotationSetting`),
`pose/view-align.js` (`alignViewRotations`).

**Imported by.** `ui/ui-wiring.js` (the View-menu click handler).

**Coverage.** `tests/e2e/align-views-to-references.mjs` — real dock panes and
menu item; pre-selection, Esc, the upside-down refusal, Apply measured on screen
through each wrapper's computed transform, dirty flags, apply-to-all.

---

### ui/view-legend.js

**Purpose.** The Visibility panel's **Display Legend** key, as DOM chrome in
each video pane rather than pixels painted onto the overlay canvas (issue #162
follow-up).

The legend was drawn by `drawLegend` (`ui/overlays.js`) into the overlay
canvas's top-right corner. That put it inside `.canvas-wrapper` — the element
`applyZoom` rotates — with three consequences: it tipped over with the video
(upside down in what was now the bottom-left at 180°); "top-right" meant the
top-right of the VIDEO, so a letterboxed pane pushed it inside the picture with
empty bar beside it; and a fixed 310 CANVAS px is a different number of SCREEN
px per camera resolution, so two views disagreed on its size. Appending it to
the `.video-cell` as a SIBLING of the wrapper fixes all three structurally —
nothing outside the wrapper can be reached by a view transform — and gets
crisper text for free (the canvas version rendered at 2x on an offscreen canvas
to compensate).

**Key exports.**
- `syncViewLegends(showLegend, opts)` — brings every view's pane into line with
  the current visibility state. Called from `drawAllOverlays`, so it inherits
  the overlays' triggers exactly; the Display Legend checkbox handler already
  ends in a redraw, so the toggle needed no extra wiring. Rebuilds a pane's rows
  only when the row SET changed (`dataset.legendKey`): this runs on every frame
  of playback, and replacing the DOM 30 times a second for an unchanging
  three-row key would be pure churn.
- `legendItems(opts)` — the rows, in order. Mirrors `drawLegend`'s item list
  exactly (same rows, same order, same conditions) so the live legend and the
  exported one cannot disagree.

Swatches are inline SVG built from the same `TRACK_COLORS` / `REPROJECTION_COLOR`
constants the overlays draw with, so the key cannot drift from what it keys.
`pointer-events: none` is load-bearing — the overlay canvas underneath is the
click target for annotation, and the legend sits over its top-right corner.

**`drawLegend` is kept and unchanged.** The overlay-video export has to burn the
legend into encoded frames, where there is no DOM; that path (`drawTileContent`,
`ui/overlay-export-modal.js`) already hoisted it out of the view transform for
the same upright-ness reason, so the two agree on what a legend IS and differ
only in where it can live.

**Styling.** `.view-legend` / `.view-legend-row` / `.view-legend-icon` in
`styles.css`, anchored `top:8px; right:8px` on the `.video-cell`. Three things
want that corner: the legend, the `.unzoom-btn` (only while zoomed) and
`#viewModeIndicator` (only in single-view mode, and on `#videoDock` rather than
the pane). Each of the latter two pushes the legend down one slot and both
together push it two, via `.video-cell.zoomed` and the
`#videoDock.has-view-indicator` class that `showViewIndicator` toggles.

**Imports.** `ui/app-state.js` (`state`), `ui/overlays.js` (the two color
constants).

**Imported by.** `ui/rendering.js`.

**Tests.** `tests/e2e/view-legend-pane-chrome.mjs` — asserts it is outside
`.canvas-wrapper`, upright and fixed to the pane corner at five rotations,
identically sized across a 1920x1080 and a 640x480 view, absent from the canvas
paint, and that `drawLegend` still works for the export.

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
reader and writer goes through), `ui/view-align-modal.js` (`getSessionRotation`
/ `setSessionRotation` / `clampRotationSetting`, writing the aligned angles —
#226). Bridged into `tests/test-runner.html` and
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
- Menu / setup: `setupMenus`, `setupUI`. The menu bar ends with a **Help**
  dropdown (Docs, Settings) after Hot Keys, and Docs / Settings are ALSO direct
  buttons at its right end (`menuBarDocs` / `menuBarSettings`, sharing
  `openDocs` / `openSettings` with the dropdown items) — #138. The Triangulate
  / Triangulate All split buttons carry a `.tri-method` span that
  `updateTriangulateButtonLabels` fills with the Settings default (": DLT" /
  ": Ref", the dropdown's own names), refreshed via
  `onDefaultTriangulationMethodChange`. The Speed popover's presets are 0.25x,
  0.5x, 1x, 1.25x, 1.5x, 2x, 3x; the popover is right-aligned to the Speed
  button so it stays on-screen. The Tracks menu hosts both
  identity↔track propagation actions (one-shot): `Propagate Tracks → IDs`
  (`menuPropagateTracksToIds` — creates an identity
  per track and assigns it to every group; sets `session.trustTracks`; was the
  old Edit-menu "Trust Track Labels" toggle) and `Propagate IDs → Tracks`
  (`menuPropagateIdsToTracks` — calls `Session.propagateIdentitiesToTracks`).
  Tracks ▸ **Check ID Switches (Body Size)…** (`menuCheckSizeSwitches`) calls
  `runIdSwitchChecks({size: true, navigateToFrame})`, and Tracks ▸ **Check ID
  Switches (Images)…** (`menuCheckImageSwitches`) `runIdSwitchChecks({image: true,
  navigateToFrame})`, from `ui/id-switch-modal.js`; `setIdSwitchNavigator` and
  `setIdSwitchRefresher` (the repaint after the tab fixes a switch) are called
  once at setup.
- Color-by toggle: the Tracks / Identity control lives in the top
  toolbar (buttons `colorByTracks` / `colorById`, next to the Errors
  checkbox), not the Tracks menu. It has no visible "Color" label (the group
  carries `aria-label="Color by"`, each button a "Color instances by …"
  tooltip), and the second button is spelled out, "Identity" rather than
  "ID". `updateColorByToggle()` reflects
  `state.colorByIdentity` on the buttons. Every change of the setting goes
  through `setColorByIdentity` (`ui/color-by.js`) and lands in the one
  handler registered here via `onColorByChange`: update the active class,
  re-render the 2D overlays via `drawAllOverlays` AND the 3D viewer via
  `update3DViewport` (whose `getGroupColor` closure reads
  `state.colorByIdentity` live, so instances recolor instantly). The buttons
  use it, and so does the tracker after Track All (#242).
- Node Trails (issue #102): two pickers for `state.trailSeconds` — the Tracks ▸
  Node Trails submenu (`#menuTrailsSubmenu`, items `menuTrailsOff` /
  `menuTrailsQuarter` / `menuTrailsHalf` / `menuTrailsSecond` / `menuTrailsTwoSeconds`) and the toolbar's
  **Trails** button (`#tbTrails`, right of Tracks / Identity). Both menus' items
  are built from `TRAIL_PRESETS` (`ui/trail-presets.js`: Off, ¼ s, ½ s, 1 s, 2 s;
  `data-trail-sec`) plus a last **Custom…** item (`data-trail-custom`,
  `menuTrailsCustom`), and both go through `setTrailSeconds`. Custom… opens
  `showCustomTrailModal` (`#trailCustomModal`): a **Seconds** and a **Frames**
  field (`#trailCustomSeconds` / `#trailCustomFrames`), the same length at the
  current rate. Typing in either rewrites the other; an invalid entry blanks the
  other, disables Apply and says why in `.modal-error`. The field typed in LAST
  is what Apply sets, and either way it is stored in seconds — so a custom
  length follows the frame rate exactly like a preset, and a length typed in
  frames is stored as `frames / fps` exactly and draws the frames typed. It
  opens on the current length, kept exact (re-applying a 10-frame trail
  untouched does not round it to its "0.167" display). A note under the fields
  names the rate ("At 60 fps.") and adds "A trail draws at most 500 frames."
  past the cap. Enter applies, Esc / Cancel change nothing. It is a dialog rather than a field in
  the menu because both menus open on hover and would close under the user the
  moment the pointer drifted. A length no preset matches checks Custom, whose
  label then names it ("Custom: 1.5 seconds (90 frames)…") in both menus. A preset is a span of
  TIME, so each item names its frame count at the current rate — "½ second (30
  frames)" at 60 fps, "(50 frames)" at 100 — and `updateTrailChecks` re-reads
  `state.fps` whenever either menu is entered (`mouseenter`/`focusin` on
  `#trailsDropdown` and `#menuTrailsParent`), because the rate changes in many
  places (video load, session switch, the FPS pill) and none of them is told
  about trails. It also moves the checkmark in BOTH menus and rewrites the
  button's tooltip ("Node trails: ½ second (30 frames)"), and gives the button
  the toolbar's `.active` blue while any trail is on (preset or custom) — the
  same look as 3D / Panel / Identity — so a trail being on reads at a glance
  without hovering the button. Off removes it. The FPS pill's commit
  redraws the overlays when trails are on, since the frame count just changed.
  The label stays a bare
  "Trails ▾" on purpose, to save toolbar width: the toolbar needs ~1,380 px
  with it (see the panel toggles below), and the value in the label would
  add ~25 px more. The button is a `.tri-dropdown`, so its menu opens on hover in
  pure CSS exactly like the Triangulate split buttons', and like theirs stays
  up after a pick until the pointer leaves; clicking the button itself does
  nothing. Display state, never saved; not in the Defining Plane Mode
  toolbar lock (it changes what is drawn, not what is annotated). Covered by
  `tests/e2e/node-trails-toolbar.mjs` (including the frame counts following the
  FPS pill) and `tests/test-trail-presets.mjs`.
- Node Style: the four per-section Node Style button groups
  (`visUserNodeStyle` / `visPredNodeStyle` / `visReprojNodeStyle` /
  `vis3dNodeStyle`) reuse the `.line-style-btn` click handler (active toggle +
  `data-value` + `drawAllOverlays` + `saveVisSettings`); they are added to
  `visStyleIds` for persistence/restore. The handler additionally rebuilds the
  3D skeleton for `vis3dNodeStyle` (`viewport3d.skeletonNodeShape = …; setFrame`).
- Visibility defaults: reprojection Brightness (`visReprojBrightness`) **50%**,
  reprojection Node Size **4**, reprojection Edge Style **solid**, predicted
  Node Size **6**, and 3D Viewer Brightness (`vis3dBrightness`) **50%**. The
  same values are mirrored in `overlay-export-layout.js` (`reproj.brightness`,
  `reproj.lineStyle`, `pred.nodeSize`), the `rendering.js`
  `getVisibilitySettings` fallbacks, and `overlays.js` `drawFrameOverlays`. The
  reprojection Brightness slider is **always enabled**: brightness tints the
  reprojection edges (and labels) whatever the Node Color, so it is not gated on
  Node Color = Track. `vis3dBrightness` is entered as a percentage and wired via
  `skelSizeIds` with `scale: 0.01` into `viewport3d.skeletonBrightness`.
- The visibility `localStorage` blob carries a `_v` version
  (`VIS_CACHE_VERSION`, now 3). Every control is saved on any panel edit, so a
  stored value equal to an OLD default is not a choice: on restore, for each
  `VIS_CACHE_OLD_DEFAULTS` entry newer than the blob, keys still holding that
  entry's old default are dropped so the new default applies (v2:
  `visReprojBrightness` `'100'`; v3: `visReprojNodeSize` `'16'`,
  `visPredNodeSize` `'20'`, `visReprojLineStyle` `'dashed'`). **Changing a
  Visibility default means adding an entry there.**
- File ▸ "Export Video Overlays" (`menuExportOverlayVideo`) is wired to
  `showOverlayExportModal()` (overlay-export-modal.js); it sits directly above
  File ▸ "Export 3D Video" (`menuExportVideo3d`), which is wired to
  `showExport3DVideoModal()` (export-modals.js).
- Session strip: the **"+"** button (`btnAddSession`) calls
  `handleEmptySession()` to create a fresh empty session directly (inheriting the
  shared project skeleton — the user then adds video via File ▸ Load Videos);
  the **"−"** button (`btnRemoveSession`) calls `removeSession`. Folder-based
  session loading stays on the File menu (`menuLoadSessionFolder` →
  `loadSingleSessionFromCache`, `menuLoadMultiSessionFolder`).
- Group ops: `unlinkGroup`, `performGroupButtonAction` (shared by the toolbar
  Group button and the `Shift+G` shortcut — context-sensitive group/ungroup),
  `showGroupContextMenu`, `hideGroupContextMenu`. The context menu's **Delete
  group** (`#ctxDeleteGroup`) removes the members' store rows first —
  `deleteTargetsFromStore(session, groupMemberTargets(frame, group))` from
  `ui/custom-delete-ops.js`, exactly as the Delete key does — then
  `removeInstanceGroup`. Removing the group from memory alone is undone on a lazy
  project by the next re-hydration or save (see `ui/interaction.js`'s
  `_deleteSelected` note); covered by `tests/e2e/sequence-lazy-workflow.mjs`
  cycle 5c (`D_CTX`).
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
  `onPlaybackStateChange`. On a lazy project, starting playback runs the
  background `lazyPlaybackLoader`: it keeps `LAZY_PLAYBACK_AHEAD` (600) frames
  hydrated ahead of the playhead and calls `evictLazyFrames(cur)` after each
  top-up, so what playback leaves behind is dropped (`pose/lazy-residency.js`).
  The Play button and Space preload the same window before starting. It was
  5000 frames with no eviction, which kept every played frame resident; the
  lookahead and the eviction's protected ahead-window are one constant, so they
  cannot drift apart.
- Toggles: `toggleInfoPanel`, `refreshInfoPanelAfterShow`,
  `updateInfoPanelToggleBtn`, `toggle3DViewport`,
  `update3DViewportToggleBtn`, `toggleTimeline`,
  `syncTimelineToggleButton`, `fitTimelineToData`.
- View modes: `enterSingleViewMode`, `cycleSingleView`, `setSoloView`,
  `setGridMode`, `updateVideoGridDisplay`, `showViewIndicator`. See
  **Single-view ("solo") mode** below.
- Playback: `applyPlaybackRate`, `seekToLabeledFrame`.
- View ▸ **Define Planes** (`menuDefinePlanes`) → `togglePlaneMode()`
  (`ui/plane-definition.js`) — enters/leaves "Defining Plane Mode". A mode, not
  a modal, so it has no Esc binding; the banner's Exit button is the way out.
  Also bound to **`Mod+Shift+P`** (`definePlanes` in `ACTION_CATALOG`, dispatched
  via `setHandler`), which calls the SAME `togglePlaneMode()` — exiting has real
  unwinding to do (Set Origin Mode, the angle dialog, the toolbar lock), so a
  second entry point would be a second place to forget it. `p` alone is Toggle
  Predictions, and the two are separated only by `matchChord`'s rule that a bare
  letter requires shift to be UP. Covered by
  `tests/e2e/define-planes-shortcut.mjs`.
- Help ▸ **Hot Keys** (`menuHotkeys`) and **`?`** (`showHotkeys` in
  `ACTION_CATALOG`) → `showHotkeysHelp()`, which renders the shortcut list from
  `getActions()`. It sits at **module scope**, and must stay there: it has two
  callers in two different closures — the menu item is wired in `setupMenus`,
  `setHandler('showHotkeys', ...)` runs in `setupUI` — and while it was declared
  *inside* `setupMenus` the second one threw `ReferenceError: showHotkeysHelp is
  not defined`, so `?` had never opened the help for any shortcut. It also
  returns early if `#hotkeysClose` is already in the DOM: `dispatchEvent` does
  not consume the keydown for the listeners after it, so a second `?` would
  otherwise stack a second overlay. There is deliberately **no `case '?'` in the
  plain-key switch** — that switch returns on any modifier and `?` is Shift+/,
  so it was unreachable, and where it was reachable it opened a duplicate.
  Covered by `tests/e2e/define-planes-shortcut.mjs` §5.

**Panel toggles: independent sizing, and hidden means idle.** `toggleInfoPanel`
(`I`) and `toggle3DViewport` (`\`) each only flip their own panel's `collapsed`
class. **Neither resizes the other** — `.video-grid-section` is the only
`flex: 1` child of `.main-content`, so it absorbs and releases the space on its
own. `toggleInfoPanel` used to hand the freed width to the 3D viewport as an
inline `style.width`, plus a temporary `flex` lock on the video grid to stop it
taking the space, and that produced two bugs: an inline width **outranks**
`.collapsed { width: 0 }`, so hiding the info panel while the 3D viewport was
collapsed **re-opened the hidden viewport** at ~300px in the space the panel had
just vacated; and writing a pixel width to a `width`-transitioned element while
the flex lock let go on the other side made the 3D viewport jitter on every
info-panel toggle. Both toggles therefore now *park* any inline width before
adding `collapsed` and restore it after removing it (`_savedWidth` on
`#viewport3dContainer`, `_savedWidth`/`_savedMinWidth` on `#infoPanel` — the
split handles write inline widths there, which would defeat the collapse the
same way).

Each toggle also drives the work, not just the pixels — see
`ui/panel-visibility.js`. Hiding the 3D viewport goes through that module's
`collapseViewport3D` (shared with Track All, which closes the panel) and calls
`Viewport3D.setVisible(false)` (render loop stopped, scene rebuilds deferred)
and lets `update3DViewport` skip out; showing it calls `setVisible(true)` then
`update3DViewport(state.currentFrame)`, which also auto-inits the viewport if a
session load released it while collapsed. Showing the info panel calls
`refreshInfoPanelAfterShow`, which rebuilds it **only if** a refresh was
actually skipped (`consumeInfoPanelStale`). Covered by
`tests/e2e/panel-toggle-independence.mjs`.

**Toolbar toggle buttons (issue #151).** Both panels have a labelled button at
the far right of the toolbar, `#viewport3dToggleBtn` ("3D") to the left of
`#infoPanelToggleBtn` ("Panel"), grouped in
`.toolbar-group.panel-toggles` and outlined (`.panel-toggle-btn`) so they read
as layout controls rather than as more annotation actions. Previously the 3D
viewport could only be collapsed from `\` or View ▸ Toggle 3D Viewport, neither
of which is discoverable. `update3DViewportToggleBtn` /
`updateInfoPanelToggleBtn` derive each button's state from the container's
`collapsed` class rather than from whoever did the toggling, so all three entry
points stay in sync; both are called from the toggle itself **and** from the
`MutationObserver` in `ui/layout-controls.js` that already watches those two
containers' class attributes (which is also what sets the initial state).

The labels are short and **fixed**: the button is highlighted (`.active`,
`aria-pressed`) while its panel is shown — the same kind of toggle as
`#tbSessions` at the toolbar's left edge — and the tooltip says what a click
will do ("Hide 3D viewer (\)" / "Show 3D viewer (\)"), via the private
`syncPanelToggleBtn`. They used to swap "Hide 3D View" / "Show 3D View" and
"Hide Panel" / "Show Panel", which cost ~95px of toolbar width and needed
`lockPanelToggleWidths` to pin each button to its wider label so a swap did not
shove its neighbour sideways ("Hide" and "Show" are different widths in a
proportional font). A fixed label cannot resize, so that function is gone. With
the short labels, and ONE divider line between toolbar groups (each
`.toolbar-group`'s right border; the extra `.toolbar-separator` beside it is
gone), the whole toolbar fits a 1440 px window (it needs ~1,380 px), which
`tests/e2e/toolbar-3d-toggle-button.mjs` asserts.

**Single-view ("solo") mode.** `v` (`singleViewMode`) calls
`enterSingleViewMode`, which caches the dockview grid layout
(`savedGridLayout`), flips `state.viewMode` to `'single'` and shows exactly one
pane — the one for `interactionManager.lastInteractedView`. Pressing `v` again
is a deliberate **no-op**: it used to advance to the next camera, so `v` was both
the mode switch and the cycler and there was no way to press it just to confirm
you were solo. Cycling moved to two places, both of which walk `state.views` —
which IS the view strip's order, since `populateViewStrip` renders straight off
it:

- **`↑` / `↓`** → `cycleSingleView(-1 | +1)`, wrapping at both ends. Wired as a
  **dedicated** keydown listener, not a catalog-dispatched action: the catalog
  dispatcher `preventDefault()`s every binding it matches, which would swallow
  the arrow keys app-wide including in grid mode where they are unbound. The
  catalog carries a reference-only (`dispatched: false`) `soloCycleView` entry so
  Settings ▸ Keyboard Shortcuts still lists it. `←` / `→` keep stepping frames.
  Each step also calls `scrollViewStripTo`, since the strip scrolls once there
  are more cameras than fit the column.
- **A single click in the view strip** → `setSoloView(name)` (see
  `ui/sessions-panes.js`), which returns false outside solo mode so the strip's
  click handler falls back to its normal focus-that-pane behaviour. This used to
  need a double-click, and that double-click *added a second pane* beside the
  solo'd view instead of swapping it.

`g` (`setGridMode`) is likewise a **no-op when already in grid mode**. The
restore is a full `clearAll()` + `fromJSON()`, which tears down and rebuilds
every pane, so a repeated `g` used to hand the selection to whichever panel
dockview activated on the way back — the grid-mode twin of the repeated-`v`
problem. Coming out of solo it restores the cached layout and then calls
`activatePanelForView` on whichever view was solo'd, so the grid comes back with
that camera selected — the yellow `strip-selected` highlight,
`lastInteractedView` (which is what new instances get created on) and the 3D
camera highlight all follow from that one `setActive()` via
`onDidActivePanelChange`. Restoring goes through `api.fromJSON()`, which builds
panels behind `addVideoPanel`'s back, so `paneManager.syncDockedViews()` runs
first to re-derive the docked bookkeeping.

**The cached layout is VALIDATED at the point of use, not invalidated at each
mutation.** `savedGridLayout` is a snapshot taken when `v` was pressed, and
`state.views` can change while solo — removing a video (`removeVideoFile`),
loading one, or switching sessions, which replaces the list wholesale. `g` then
`fromJSON`'d the snapshot and rebuilt a pane for a view that no longer exists:
an empty pane wearing the removed camera's name, which is what a user reads as
"the video went blank" (luc3d #216). A view ADDED while solo is the same mistake
mirrored — `g` would restore a grid missing it. `savedGridLayoutMatchesViews()`
compares the snapshot's panel set against the live view list as a SET (both
directions), and `setGridMode` drops the layout when it disagrees, falling back
to a fresh `addAllViewsAsGrid()`. Validating at the one reader rather than
invalidating at every writer is deliberate: a list of invalidation call sites is
a list something can be left off, and this cache has exactly one reader. It
reads `params.viewName` off the SERIALIZED panel records — the `params` every
pane is added with, part of dockview's documented `toJSON` shape, not one of the
private internals `ui/overlay-export-modal.js` depends on.

Covered end to end by `tests/e2e/solo-view-navigation.mjs` (real keyboard/mouse
events against the real dock and strip) and `tests/e2e/videos-panel-buttons.mjs`
§7 (the stale snapshot, the positional drift of `singleViewIndex`, and removing
the solo'd view itself);
`tests/test-view-mode.js` only simulates the index arithmetic in isolation.

**Visibility panel — the global/session split.** `saveVisSettings` /
`restoreVisSettings` cache the panel's **global appearance preferences** (the
`visSliderIds` / `visCheckIds` / `visStyleIds` lists — User, Predictions,
Reprojections, Planes, Display Legend and 3D Viewer) in
`localStorage.visibilitySettings`. Those are browser-local display taste, shared
across every session, and are deliberately **not** written into the `.slp`:
baking them into the project file would make opening a colleague's project
silently reassign your node sizes and 3D widgets. The panel's *session-scoped*
settings — per-camera video brightness / contrast / rotation and the timeline
hidden sets — take the opposite route and persist per session via
`import-export/visibility-metadata.js`; they never touch localStorage.

The **`Planes` section**'s four toggles (`PLANE_VIS_IDS`, imported from
`ui/plane-visibility.js` rather than re-typed, so this file cannot drift from
the module that reads them) are wired apart from the other checkbox toggles for
two reasons: they need BOTH repaints — `drawAllOverlays` for the 2D overlays and
`syncPlanes3D` for the 3D scene, which is rebuilt rather than redrawn — and no
pose selection can point at a plane, so the deselect sweep the other toggles
share has nothing to do for them.

**Hold-to-rotate (`Shift+R` + `←`/`→`).** `rotationLoop` advances
`view.rotation` by a fractional `60 * dt` every frame so the animation stays
smooth, and keeps the session store out of it. The gesture is committed **once,
on keyup**: `setSessionRotation` stores the rounded degree, `view.rotation`
snaps onto exactly that value (so what renders after the gesture is what a
reopen will render), and `markDirty()` fires. Persisting per animation frame
would be 60 Hz of churn on project state.

`redrawForRotationDegree(view)` repaints the overlays when — and only when —
`Math.round(view.rotation)` changes, tracked in `_rotState.drawnDeg` (null
starts a gesture, forcing the first paint; keyup clears it so the final,
snapped angle always repaints). Before issue #162 the loop deliberately
repainted NOTHING and waited for keyup, which was right while labels rotated
with the video; now that they cancel the view's rotation, a gesture with no
repaint would leave every label spinning until the key came up. Whole degrees
rather than frames because that is the granularity labels are drawn at
(`ui/rendering.js` passes `Math.round(view.rotation)`), so a skipped repaint
could not have changed a label's angle — and it is what keeps this off an
unconditional per-animation-frame redraw of every view.

The chord's "don't also step frames" guard sits **before** the `hasRealVideo()`
branch in the arrow-key handler. It used to sit after that branch's `return`,
so on a project with no decoder (skeleton + imported 3D points) every arrow
press of the chord both rotated the view and advanced the frame.

`showViewIndicator` additionally toggles **`has-view-indicator`** on
`#videoDock`. Its chip is absolutely positioned at the dock's top-right, which
in single-view mode — the only mode it appears in — is exactly where the sole
pane's Display Legend key wants to sit; the class is what makes the legend step
down a slot instead of hiding under it (styles.css). Removed on every path that
hides the chip, or the legend would sit low in grid mode forever.

**Imports from project modules.** Nearly every other module — see file
header for the full list. Notable ones: `app-state.js`,
`timeline-controller.js`, `pose-data.js`, `triangulation.js`
(incl. `evictLazyFrames`), `lazy-residency.js` (`LAZY_PLAYBACK_AHEAD`),
`rendering.js`, `info-panel.js`, `save-load.js`, `slp-import.js`,
`file-io.js`, `session-loader.js`, `video.js`, `tracker.js`,
`initialization.js`, `identity-assignment.js`, `export-modals.js`,
`sessions-panes.js`, `settings.js`, `settings-modal.js`,
`track-range-modal.js` (`showTrackRangeModal`, wired to the Track Frame split
button's `#tbTrackFrameRange` dropdown item — #212),
`view-align-modal.js` (`showAlignViewsModal`, wired to View ▸ "Align Views to
References…" — #226),
`seekbar-tooltip.js` (`installSeekbarTooltip`, the seekbar's hover tooltip —
#142),
`frame-readout.js` (`showReadoutFrame`, `refreshReadoutTotals` — the
time / frame readout, written by `updateSeekbarVisual`, the inline frame editor
and the FPS pill),
`seekbar-markers.js` (`installSeekbarMarkers`, `seekbarMarkerAt`,
`describeSwitchMarker`, `setSeekbarMarkerFrames` — the possible-ID-switch ticks:
the scrub handlers and the tooltip snap to a tick within 5 px),
`color-by.js` (`onColorByChange`, `setColorByIdentity` — the Tracks /
Identity toggle, also flipped by the tracker after Track All — #242),
`trail-presets.js` (`TRAIL_PRESETS`, `MAX_TRAIL_FRAMES`, `trailPresetFor`,
`trailLabel`, `trailFrames`, `trailRate`, `formatTrailSeconds`,
`trailSecondsForFrames`, `parseTrailSeconds`, `parseTrailFrames` — the Node
Trails menus and their Custom… dialog),
`video-filters.js` (`setSessionRotation`; `clampRotation` still comes in via
`sessions-panes.js`, which re-exports it), `plane-definition.js`
(`togglePlaneMode`).

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
picks). Both handlers `stopPropagation()` so the click does not also reach the
document listener that closes the toolbar menus — which is why the focus-release
listener in `ui/keyboard-target.js` has to run in the **capture** phase (#230):
in the bubble phase these two buttons kept focus after a click and swallowed
`Space`/`Enter`. Implicit triangulation — the `t` shortcut, the Edit ▸
Triangulate menu item, and the auto-assign flow in `identity-assignment.js` —
also uses the default method. The **environment-skeleton** solve (Load
Environment) likewise takes it, via `resolveTriangulationMethod(group)` on a
brand-new group; it used to hardcode DLT, so a BA user's environment 3D
silently disagreed with the method they had selected.

**Track Frame is a split button too (#212).** It reuses the same `.tri-dropdown`
markup and CSS-only hover reveal, but NOT `wireTriDropdown` — its button keeps
its own click handler in `pose/tracker.js`'s IIFE (`trackCurrentFrame`,
unchanged), and `ui-wiring.js` wires only the one menu item,
`#tbTrackFrameRange`, to `showTrackRangeModal()`
(`ui/track-range-modal.js`) — passing `navigateToFrame` in as `onTracked` so the
modal can park the viewer on the last frame a run tracked, injected because
`navigateToFrame` lives in `initialization.js`, which imports this module, which
imports the modal. The menu is revealed purely by `:hover`, which is
worth knowing when driving it from a test: a modal opening over the toolbar
drops hover, so a second click on the item has to re-hover the button first (see
`tests/e2e/track-frame-range.mjs`).

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

**One focus guard, not ten copies.** All seven `keydown` listeners here (and the
ones in `ui/settings.js`, `ui/interaction.js` and `loading/video.js`) now ask
`shouldIgnoreShortcut(e)` from `ui/keyboard-target.js` instead of each testing
`e.target.tagName === 'INPUT'` — a test that was also true for a CHECKBOX, so
clicking a toolbar checkbox killed every shortcut in the app (issue #163).
`setupUI` additionally calls `installFocusRelease(document)` first thing, which
hands focus back after a POINTER activates a checkbox, radio or button so the
key they share with a shortcut goes to the shortcut. Keyboard focus is left
alone, so tabbing to a checkbox and pressing `Space` still toggles it.

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
  `setPlanes`, `clearPlanes`, `setMeshMembership`, `clearMeshMembership`,
  `setSelectedPlaneNode`, `clearSelectedPlaneNode`,
  `setAnglePreview`, `clearAnglePreview`, `setPlaneRoles`, `clearPlaneRoles`,
  `setOriginPickMode`, `setOriginCandidates`,
  `clearOriginCandidates`, `setOriginFrame`, `clearOriginFrame`,
  `addCameraPyramids`, `selectCamera`, `showSelectedCameraView`,
  `showInitialView`, `setMissingVideoCameras`, `highlightCamera`,
  `resize`, `resetCamera`, `lookAtOrigin`, `fitToScene`, `originPivot`,
  `originUp`, `setVisible(visible)` / `isVisible()`, `dispose`.
- **`setVisible(false)` stops ALL processing** (the `\` toggle's other half —
  see `ui/panel-visibility.js`). A collapsed container is still a perfectly
  good render target as far as WebGL is concerned, so the `_animate()` loop
  used to render the whole scene ~60x/second into pixels nobody composites.
  Hiding cancels `_rafId` (and the camera fly-in's separate rAF loop, which
  renders directly and would otherwise keep drawing) and routes every scene
  rebuild — `setFrame`/`setSelectedInstance`, `addCameraPyramids`,
  `setEnvironment`/`clearEnvironment`, `highlightCamera`, `fitToScene` — into
  `_deferred`, a Map of at most one thunk per `DEFER_REPLAY_ORDER` key, so
  scrubbing 10,000 frames while hidden leaves ONE pending `'frame'` rebuild
  rather than 10,000. Nothing is disposed, so the scene graph, the WebGL
  context and the user's orbit pose survive and re-showing is instant.
  `setVisible(true)` replays the deferred thunks in `DEFER_REPLAY_ORDER`
  (geometry first, then what reads it back: `'highlight'` needs
  `addCameraPyramids`' meshes, `'fit'` needs `setFrame`'s skeleton), then
  resizes — the container was 0x0 while collapsed, so every `resize()` in that
  window early-returned. `setEnvironment` is the one deferral that captures
  `this.skeleton` explicitly: callers set an env-specific skeleton, call in,
  and restore the normal one on the next line. `visible` is a per-instance
  constructor option (default `true`) rather than a DOM read, because the two
  export-modal instances must keep rendering regardless of the main panel.

**Scene groups.** Nine `THREE.Group` siblings under the scene: `_cameraGroup`,
`_skeletonGroup`, `_envGroup`, `_planeGroup`, `_meshMembershipGroup`,
`_angleGroup` (the Set Angle ghost), `_planeRoleGroup` (the Set Angle role
outlines), `_originGroup` (the Set Origin candidate arrows) and `_framePivot`
(the grid floor + axis helper).
**`updateSkeleton` clears ONLY `_skeletonGroup`**, every frame — that is the
entire mechanism by which the environment overlay and annotated planes persist.
Anything frame-independent must be a sibling, never a child of
`_skeletonGroup`.

**Plane corners size independently of pose nodes.** `setPlanes` uses
`this.planeNodeSize` (the panel's "3D Node Size" slider, pushed in by
`syncPlanes3D`), not `skeletonNodeSize` — sizing reference geometry for
legibility must not resize the pose annotation.

**`showPlaneSurfaces` / `showPlaneNodes`** (both default `true`) decide which
meshes `setPlanes` builds: the plane BODY — its edges and its fill — and its
CORNERS, independently. They are the Visibility panel's "Planes in 3D Views" /
"Nodes in 3D Views" toggles, pushed in by `syncPlanes3D` and forced on inside
Defining Plane Mode (`ui/plane-visibility.js`). They **never filter `_planes`**:
the ids in it are what a live drag, `setSelectedPlaneNode`'s marker,
`setMeshMembership`'s highlight and `setPlaneRoles`' outlines all resolve
against, so hiding a plane must cost meshes and nothing else. With the corners
off nothing is pickable, which is correct — the payload is only `editable`
inside the mode, where both flags are on.

**`setPlanes(planes)` / `clearPlanes()`** — user-annotated planes from
View ▸ Define Planes (`ui/plane-definition.js`'s `syncPlanes3D`). Full rebuild
per call, like `setEnvironment`. Payload per plane:
`{id, name, color, nodeIds, nodeColors, nodeImmutable, edges, polygonOrder,
filled, editable, planeFit, fitted, points3d}` — where `nodeIds` is the POOL
ids behind this plane's corners (parallel to `nodeColors`, and what
`setSelectedPlaneNode` resolves against) and `planeFit` is a **usable** fit
(the drag surface, stored or derived) and `fitted` is whether the user has
actually clicked Fit, which is the different question Set Origin asks. Nodes
are spheres in their own per-node colour (the cross-view correspondence cue),
edges reuse `_createCylinder`, and `filled` adds a fan-triangulated
`BufferGeometry` mesh built by `_buildPlaneFillMesh` — `DoubleSide` because a
plane is viewable from either face, `depthWrite: false` so the translucent fill
never occludes nodes behind it. The fan walks `polygonOrder`, so it covers the
real outline rather than an index-order bowtie, and a corner in the middle of a
plane is covered by the fill instead of being a vertex of it. A fan is only
valid over a convex ring, which a hull always is; a user-drawn CONCAVE ring can
still fan wrong, which is the price of honouring their edges. **`points3d` needs no
transform**: the Three camera is Z-up and the scene is already in the
calibration's world frame, so coordinates go straight into `position.set`, the
same as skeleton nodes and camera centres.

**`setAnglePreview(spec)` / `clearAnglePreview()`** — a GHOST of where
**Set Angle Between Two Planes** would put the plane being rotated, shown live
while its dialog is open and cleared on Cancel, Esc and Apply. ADDITIVE in the
same way `setMeshMembership` is: its own group, its own pair of calls, and nothing
in it touches `_planeGroup`. Geometry comes from the caller — the PLANNED
points, which have not been written to any node — while the plane's edge list,
polygon ring and colour are read back out of the last `setPlanes` payload by
`spec.planeId`, so the ghost is drawn exactly like the real plane and there is
no second copy of that payload shape to keep in step. The fill reuses
`_buildPlaneFillMesh`, so a concave ring is ordered the same way it is for the
solid plane and only the material differs. **`depthTest: false` on purpose:**
the ghost overlaps the plane it proposes to replace, the useful thing to see is
the DIFFERENCE between the two, and a depth-tested ghost is hidden by the very
plane it is about to move — the same reasoning as the dimmed, non-depth-tested
unchosen arrow in the origin picker. `clearPlanes()` clears it too, since a
proposal about a plane that is no longer here must not hang in the scene. It is
pure display: nothing here writes a node or marks the project dirty.

**`setPlaneRoles(roles)` / `clearPlaneRoles()`** — fat, see-through-everything
outlines saying WHICH planes the Set Angle dialog's two dropdowns are naming,
and which of them is being held. `roles` is `[{planeId, color}]`; `null` or `[]`
clears. A THIRD group rather than the ghost's, because the two answer different
questions and are cleared at different times — a refused plan drops the ghost
while the roles are still what the user is choosing between. Geometry comes
from the last `setPlanes` payload (the plane AS IT IS; the ghost is the one
showing the proposal), corners are drawn as well as edges so a plane with no
edge list still reads, and `renderOrder` 8 puts it under the ghost's 9/10 so a
proposal is never obscured by the highlight of the plane it would move.
`clearPlanes()` clears it too. Pure display.
**`setMeshMembership(payload)` / `clearMeshMembership()`** — MEMBERSHIP
highlighting for the SELECTED 3D Mesh Object, pushed by `syncPlanes3D`. Payload
`{planeIds}`; `null` clears. ADDITIVE: its own `_meshMembershipGroup`, a
sibling of `_planeGroup` that the per-plane fills above never touch.

**It draws the member PLANES, not a derived body**, and that is the design. An
object IS its member planes — the same cage already on screen — so each member's
FACE is filled and its corners and edges redrawn, fatter, in `MESH_MEMBER_COLOR`
(one fixed yellow). Four consequences worth stating:

- **The face is the part that reads.** Corners and an outline alone left every
  plane wearing its own colour, so on a five-walled cage "is this wall in the
  object?" came down to a few dots. The face is built by
  `_buildPlaneFillGeometry` — the same ring-walking fan as the plane's own fill,
  split out of `_buildPlaneFillMesh` so a highlight can never disagree in shape
  with the surface it highlights — at opacity 0.45 against the fill's 0.28, and
  it is drawn whatever the plane's own `filled` flag says, because what is being
  shown is MEMBERSHIP and not the plane's display setting. `depthTest` stays ON
  for the face (a filled face ignoring depth paints a cage's back walls over its
  front) and OFF for the corners and outline (so an occluded member still
  announces itself).
- **The colour is fixed, not the object's.** A highlight has to be legible
  against whatever colours the user gave their planes, and an object drawn in a
  colour of its own competes with five plane colours at once. The payload
  therefore carries **no colour field at all** — an unused one would be an
  invitation to wire the object's colour back in. Only one object is selected at
  a time, so a shared highlight colour is never ambiguous; the object's colour
  stays its identity in the table swatch, the editor and the `.glb`
  `baseColorFactor`.
- **It cannot drift.** Positions are read out of `this._planes`, the very
  payload the plane drawing was built from, so a highlight is always exactly on
  top of its plane. The previous version pushed the object's DERIVED geometry
  instead, which `pose/mesh-object-geometry.js` builds in the user's **origin
  frame** — while this group, like every data group, hangs off `scene` rather
  than `_framePivot` and is drawn in **calibration world**. Defining an origin
  therefore made the object float away from the cage, translated and rotated by
  the frame. Pinned by `tests/e2e/mesh-membership-highlight.mjs`, which asserts
  exact equality with a frame set and shows the derived vertex to be elsewhere
  as its control.
- **Winding is no longer shown here.** The old two-tone front/back surface made
  "I am looking at the inside" visible; membership highlighting does not. Nor is
  it reported in the panel — winding is derived, not chosen, so there is nothing
  for a user to act on and a read-out would be prose nobody can use.

A member plane that was deleted simply has nothing to light up — the same lazy
resolution the model uses, no cascade and no throw. `renderOrder` 7 puts the
whole highlight ABOVE the plane fills (0) and UNDER the Set Angle role outlines
(8), so it covers the plane it lights up while an open angle dialog still reads
over it.

**`setSelectedPlaneNode(payload)` / `clearSelectedPlaneNode()`** — the ONE plane
node selected in the Nodes table, pushed by `syncPlanes3D`'s
`syncSelectedNode3D`. Payload `{nodeId}`; `null` clears. ADDITIVE, in its own
`_nodeSelectGroup`, a sibling of `_planeGroup`. Four things about it:

- **A pool node ID crosses the boundary, never a position.** `_findPlaneNodePoint`
  resolves it against `this._planes` (the payload's `nodeIds`), so the marker is
  built from the very numbers the corner was drawn from — the same rule
  `setMeshMembership` follows, and for the same reason: a position computed
  anywhere else may be in the user's ORIGIN frame while this group is drawn in
  CALIBRATION world.
- **One marker, even for a shared corner.** The first plane carrying the id
  wins and there is nothing to choose between them — every plane referencing a
  node draws it at that node's one position, which is what a shared corner IS,
  and a second marker on top of the first would only z-fight with it.
- **Three rings, in the three coordinate planes, with an EMPTY middle.** A
  corner is about a dozen pixels across at a normal zoom, so anything solid
  drawn over it — a ball, or a wireframe sphere, whose lines close up into one
  at that size — hides the node's own colour, which is how the user knows they
  landed on the right one. Three at right angles rather than one facing the
  camera: one ring would need re-aiming every orbit (per-frame work this
  viewport otherwise stays free of) and edge-on it is a line, while three
  cannot all be edge-on at once. `NODE_SELECT_COLOR` is white and fixed, for
  the reason `MESH_MEMBER_COLOR` is: a node wears its own colour everywhere
  else, so a marker in that colour is invisible on the one node it is about.
- **A node in no plane is marked nowhere.** The 3D view draws planes; a node no
  plane references is not in it, and inventing a marker for it would draw a
  point the user cannot see anywhere else. `depthTest: false` and
  `renderOrder` 7, like the membership outline — a corner behind a filled wall
  is exactly the one worth finding. `clearPlanes()` clears it too, since
  `_planes` is what it is resolved through.
  Pinned by `tests/e2e/plane-node-selection.mjs`.

**Dragging a plane corner in 3D** (`_setupPlaneEditing` and friends;
callbacks `onPlaneNodeDragged(planeId, nodeIdx, [x,y,z])` /
`onPlaneNodeDragEnd(planeId, nodeIdx)`, wired by `syncPlanes3D`). Two rules,
both enforced here rather than by the caller:
1. **Only a plane WITH A FIT is draggable, and never a PINNED corner.**
   `setPlanes` stamps
   `userData.planeEditable = editable && planeFit && !nodeImmutable[k]` on each
   corner mesh and the raycast only ever collects those, so a corner with no
   plane — no constrained direction to move in — is inert. `planeFit` asks
   whether there IS a surface, not who supplied it: the caller sends a
   **usable** fit, so an un-Fit plane with three solved corners is draggable
   too (see `ui/plane-definition.js` > `syncPlanes3D`). The `nodeImmutable` term
   matters because `planeEditable` also gates the **hover cursor**
   (`_pickPlaneNode`, used by both the drag and the `'move'` cursor): without it
   a pinned corner would advertise a drag that `onPlaneNodeDragged` then
   refuses.
   **`userData.planeFitted` comes from the payload's separate `fitted` flag**,
   not from `planeFit`, and deliberately does not follow `planeEditable` down
   either. Set Origin's picker asks whether the user has DECLARED this plane's
   frame — the question `fittedPlanes()` counts — so a derived surface must not
   make an un-Fit plane eligible to define the project's origin; and a pinned
   corner is a *preferred* Set Origin anchor and must stay pickable. A payload
   that omits `fitted` falls back to `!!planeFit`, so an older caller is
   unchanged.
2. **A corner can only move WITHIN its fitted plane.** The drag resolves the
   pointer ray against a `THREE.Plane` built from the fit's normal + centroid,
   so the result is on the plane by construction — there is no "move then
   re-project" step that could drift. Near-parallel rays (`|cos| < 1e-3`, an
   edge-on view) are refused rather than flung to a huge coordinate.

The fit itself is held **fixed** for the drag and not re-derived after it:
centroid + normal are what a later step turns into the origin's translation +
rotation, so a corner nudge must not move the frame it defines (and re-fitting
mid-drag would let the plane chase the corner being dragged).

The `pointerdown` listener is **capture-phase on `container`, not on the
canvas** — OrbitControls registered its own canvas `pointerdown` first, and at
the target element capture and bubble listeners fire in *registration* order, so
a canvas capture listener would still run second and the orbit would already
have started. From an ancestor the capture phase genuinely precedes the target,
which lets it `stopPropagation()`. `controls.enabled` is also flipped for the
duration. `_suppressCameraClick` swallows the one `click` that follows a drag
released over a camera pyramid, which would otherwise jump the view into that
camera's perspective. `dispose()` removes the container listener — it outlives
the viewport, so leaving it attached would keep a disposed instance firing.

**Set Origin support** (`setOriginPickMode` / `setOriginCandidates` /
`setOriginFrame`, driven by `ui/origin-definition.js`).
- `setOriginPickMode('node'|'axis'|null)` arms picking. While armed the click
  handler **consumes the click even on a miss** — a stray click must not select
  a camera and swing the view away from the corner being aimed at. `'node'`
  only ever collects meshes flagged `userData.planeFitted`.
- `setOriginCandidates({origin, normal, length, chosen})` draws both ±normal
  arrows as real shaft+head **meshes** — not `ArrowHelper`, whose `Line` shaft
  raycasts against a distance threshold rather than geometry and is unreliable
  to click. `chosen` dims the loser instead of removing it. `length` comes from
  the caller because it must scale to the plane, not the camera baseline.
- `setOriginFrame(frame)` moves `_framePivot` (grid + axes) onto the user's
  frame via `makeBasis` — basis **columns**, since a parent transform maps
  frame-local coordinates out into world. Only the frame and the ORBIT move; no
  data group is touched.

**The orbit follows the applied origin** (`originPivot` / `originUp` /
`_rebaseControls`, plus `_frameDirection`). Interaction is part of the display:
re-basing only the grid would leave drag, pan and wheel keyed on a calibration
origin that is no longer drawn anywhere, so the whole scene would swing about an
invisible point. `_rebaseControls` moves `controls.target` onto the frame's
origin and `camera.up` onto its +Z, and translates the camera by the same delta
so the **view does not jump** — direction and distance survive, only the pivot
changes. Zoom needs nothing extra: OrbitControls dollies along the camera→target
ray, so moving the target moves the zoom centre with it. `setOriginFrame(null)`
is symmetric, putting the orbit back on the calibration origin and world +Z.

**Why the controls get REBUILT, not just re-aimed.** r147's OrbitControls bakes
the orbit axis in at construction: `update` captures a quaternion from
`camera.up` once, when its closure is defined, so a later `camera.up = …` re-aims
the camera and nothing else. `_createControls` therefore owns construction (and
the `'change'` → `_checkDeclutter` listener, so a rebuild keeps it) and records
the axis actually in force as `_controlsUp`; `_rebaseControls` rebuilds only when
the axis really moved — a re-applied frame or a Reset View is a plain
`controls.update()`. `minDistance`/`maxDistance`/`enabled` carry across.

**`resetCamera` / `fitToScene` / `showInitialView` are frame-relative.** The
canned viewing angles (`(500,-500,400)`, `(1,-1,0.8)`) are stated in FRAME
coordinates and rotated out through `_frameDirection`, so "the default view"
means the same angle onto the user's grid as onto the calibration's. With a frame
applied `fitToScene` also fits **around the frame's origin** rather than the
point cloud's centroid, measuring its radius from that same point: framing one
point while orbiting another is exactly what makes the first drag after a fit
swing the scene off-centre.

**Picking calls `scene.updateMatrixWorld()` first.** Raycasting reads
`matrixWorld`, which is otherwise only refreshed by `render()`. The origin
arrows are built in response to the PREVIOUS click, so a click arriving before
the next frame would raycast against stale (identity) transforms and silently
miss. Same guard in `_pickPlaneNode`, where `setPlanes` rebuilds mid-drag.

**`fitToScene` counts plane nodes.** Its point set is camera positions +
`node_*` inside `_skeletonGroup` + **`planeNode_*` inside `_planeGroup`** +
the origin. Without the plane term the view stays on the cameras and an
annotated plane — the whole reason for the mode — sits off screen. The
`planeNode_` prefix deliberately does not match the `node_` test, so nothing is
double-counted, and `_planeGroup` is empty until a plane is triangulated, so
framing is unchanged for projects with no planes.
- Constructor options `skeletonNodeShape` (`'circle'` sphere / `'square'` cube /
  `'triangle'` tetrahedron / `'x'` crossed bars — `updateSkeleton` builds the
  matching node geometry) and `preserveDrawingBuffer` (keeps the WebGL buffer
  after compositing so the canvas can be captured frame-by-frame; used by the
  Export 3D Video modal). A second `Viewport3D` can be mounted in the export
  modal's container, reusing this class rather than duplicating 3D code.
- **`updateSkeleton` updates IN PLACE** (it runs on every playback frame — the
  3D view follows the video at full rate). Meshes and materials live in a pool
  (`_skelPool`, built by `_ensureSkeletonPool`, one slot per instance group from
  `_newSkeletonSlot`) and are only repositioned / recolored; every edge is the
  ONE shared unit `CylinderGeometry` (radius 1, height 1) scaled to
  `(radius, length, radius)`. The pool is rebuilt (`_disposeSkeletonPool`) only
  when node shape, node size, edge weight, show-nodes/edges or the `skeleton`
  object changes. The attached scene graph is identical to the old rebuild's:
  one `instance_<g>` Group per group with 3D, children = that frame's valid
  `node_*` markers then `edge_*` cylinders, same order; unused pooled objects
  are DETACHED (not hidden), so traversals (`fitToScene`, tests) are unchanged.
  Detaching goes through `_detachChildren` (`remove()`, like `_clearGroup`) rather
  than `Object3D.clear()`, so it works with the test runners' THREE mocks.
  Steady-state cost ~0.05 ms vs ~1 ms for the rebuild (which also re-uploaded a
  cylinder buffer per edge per call). Guarded by
  `tests/test-viewport3d-skeleton-pool.js` (pooled == fresh build after any
  frame sequence; world-space edge endpoints/radius). `setEnvironment` still
  builds per call via `_createCylinder` (not per-frame).
- Constructor option / property `skeletonBrightness` (0..1, **default 0.5**):
  `updateSkeleton` scales each group's track/identity color by it
  (`THREE.Color.multiplyScalar`, the 3D counterpart of the 2D reprojection
  Brightness). The factor is part of each pooled slot's recolor key
  (`slot.brightness`, beside `colorStr` / `selected`), so changing it recolors
  on the next `setFrame` without rebuilding the pool. The **selected** instance keeps its full color so the selection
  still stands out. Driven by the Visibility panel's 3D Viewer ▸ Brightness (%)
  input (`vis3dBrightness`); `pose/initialization.js`, the Export 3D Video modal
  (`export-modals.js`) and the overlay-export 3D tile (`overlay-export-modal.js`)
  all read that input when constructing their `Viewport3D`.

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

**Coverage.** `tests/e2e/panel-toggle-independence.mjs` pins the pause: it
wraps `renderer.render` and asserts ZERO draws across four frame steps with
the panel collapsed, then asserts the scene resyncs to the CURRENT frame (not
the one it was hidden on) when re-shown. `_rafId === 0` alone is not a
sufficient assertion — the loop is stopped by two independent mechanisms and
either one on its own zeroes the handle.

---

### ui/info-tip.js

**Purpose.** The ⓘ explanation, shown where the user is looking — a small
popover beside the pointer.

The text used to go to `setStatus`, which paints it in the status bar at the
**bottom-left of the window**: the furthest point on screen from the icon just
clicked, outside the region being read on any wide window, and a bar that also
carries save results, triangulation counts and errors — so a help string sat in
it afterwards.

A **LEAF module** — it imports nothing. Every panel with something to explain is
a caller, and several of those already import each other.

**Key exports.**
- `setInfoTip(el, text)` — declare an explanation. Sets `data-infotip`, and
  **removes `title`**: left on, the native tooltip surfaces a second later
  saying the same sentence in a second place. The text stays reachable to
  assistive tech as `aria-label`. Idempotent, so a renderer may call it on every
  repaint.
- `installInfoTips()` — install the delegated listeners; call once at startup
  (`pose/initialization.js`, before any panel renders). Further calls are
  no-ops, so a second caller cannot double every handler.
- `hideInfoTip()` — put it away.

**Delegation, not per-element wiring.** One `#infoTip` element and one set of
listeners on `document`, matching `[data-infotip]`. The plane panel rebuilds its
tables on almost every interaction: an info button wired at creation time would
have to be re-wired by every renderer, and the one that forgot would fail
SILENTLY — an icon with no tip looks exactly like an icon whose text is empty.
A `tests/e2e/info-tip.mjs` case creates a `[data-infotip]` element after startup
and asserts it is served with no wiring at all.

**The tip lives and dies with the hover.** It appears when the pointer reaches
the icon and goes away when the pointer leaves — **including when the icon was
clicked**. A click only guarantees one is showing, which is what a touch device
needs (a tap, and no hover to have shown it already); it buys no extra time.
Anything a click pinned open is an explanation that outlives the question,
sitting over a panel the user has already moved on from and needing a second,
deliberate click to clear. The single exception is a tip summoned by the
KEYBOARD: no pointer to leave, so it waits for blur or `Esc`.

**A click must not also do the thing underneath.** These icons sit inside
things that are themselves clickable — a table row, and the `<summary>` that
folds the very section being asked about — so the click listener is registered
in the CAPTURE phase and calls `stopPropagation`. `preventDefault` is not also
needed, and was tried: every ⓘ in the app is a `<button>`, which makes the
button the click's activation target, so a `<summary>` ancestor's fold never
runs. That holds only while the icon has its own activation behaviour — a plain
`<span>` ⓘ inside a `<summary>` WOULD fold it, since the DOM runs activation
behaviour after dispatch and stopping propagation does not reach it.
`tests/e2e/plane-section-info.mjs` §4 pins the behaviour either way, and also
that the heading BESIDE the icon still folds.

**Four details that are not taste.**
- **The keyboard path is gated on `:focus-visible`.** Clicking a `<button>`
  focuses it, so without the gate a mouse click marked the tip keyboard-held and
  it survived the pointer leaving — precisely the behaviour the hover rule above
  forbids. `:focus-visible` is exactly the "arrived by keyboard" signal, so the
  two paths stop overlapping. `tests/e2e/info-tip.mjs` §4 goes red without it.
- **`pointer-events: none` on the tip.** It follows the cursor, so without this
  it slides under the pointer, takes the hover, fires `mouseout` on the icon and
  flickers itself away.
- **It FLIPS to the other side of the pointer rather than clamping.** Nearly
  every info icon is in the right-hand panel, close enough to the edge that a
  clamped tip would cover the pointer and the icon under it.
- **A scroll DISMISSES it** (`position: fixed` does not follow one), unlike the
  pin picker, which repositions. The difference is whether the user is mid-
  interaction: a picker is, a sentence they have finished reading is not.

Leaving the icon, clicking elsewhere, `Esc`, blur, a scroll or a resize all
dismiss.

**Imported by.** `ui/plane-definition.js` (the Pinned column's ⓘ and the four
major sections' ⓘ), `pose/initialization.js` (`installInfoTips`).

Coverage: `tests/e2e/info-tip.mjs` — placement beside the cursor, the viewport
clamp and the flip, hover/click/Esc/outside-click dismissal, that `title` is
gone while `aria-label` is not, that the status bar is left untouched (the
regression), and the delegation case above. `tests/e2e/plane-section-info.mjs`
covers the section headings' ⓘ and the no-fold rule.

### ui/section-state.js

**Purpose.** Remember which collapsible `<details>` sections a user left open,
across page loads.

A `<details>` keeps its state only as long as its DOM node lives — the app
session. But **loading a project reloads the page**, so the markup's `open`
attributes came back and every section in the Define Planes panel was expanded
again; the user refolded the same four or five after every load. The state has
to outlive the document, so it lives in `localStorage`.

**Browser-local display taste, NOT project state** — the same classification as
the plane panel's node-size / edge-width sliders and the Visibility panel's
global appearance prefs. It must never be written into the `.slp`: it would move
`save-golden-digest.mjs`, and opening a colleague's project would refold your
panel.

A **LEAF module** — it imports nothing. `ui/info-panel.js` (Skeleton ▸ Nodes /
Edges) and `ui/plane-definition.js` (the whole Define Planes panel) both use it
and already sit on opposite sides of several import chains, so anything with its
own imports would risk closing a cycle.

**Key exports.**
- `persistSectionState(id, key)` — restore one `<details>` from `key`'s map,
  then listen for `toggle`. **Restore first, listen second**: assigning
  `el.open` itself fires `toggle`, so a listener attached earlier would open by
  writing back what it had just read. An id with **no stored value keeps the
  markup default**, which is what lets a section ship collapsed without this
  module having an opinion.
- `persistSectionStates(ids, key)` — the same for several under one key.

**Storage is best-effort on BOTH sides.** Private windows, blocked site data and
quota errors make `localStorage` throw on read *and* on write, and a section
that cannot be remembered must still open and close — so every access is
wrapped and a failure degrades to the markup's default. The `toggle` handler
**re-reads the map** rather than mutating a captured copy: several sections
share one key and each holds its own closure, so a stale copy would write back
its neighbours' state as it was when that one section was wired.

**Callers and their keys.**
- `skeletonSectionsOpen` — `skeletonNodesSection`, `skeletonEdgesSection`.
- `planeSectionsOpen` — `planeNodesDetails`, `planePlanesDetails`,
  `planeMembersDetails`, `planeEdgesDetails`, `planeActionsDetails`,
  `planeAppearanceDetails`, `meshObjectsDetails`, `originResultDetails`.
  The sub-sections are included deliberately: Planes is the tallest thing in
  the panel and most of that height is its four sub-sections.
  **`originDangerDetails` is deliberately ABSENT** — it ships collapsed because
  it holds the three actions that rewrite the calibration every downstream tool
  reads, and a Danger Zone left open because it was expanded once, weeks ago, in
  a different project is exactly the state being collapsed is for.

**Imported by.** `ui/info-panel.js`, `ui/plane-definition.js`.

**The panel's MAJOR sections are OUTLINED, its sub-sections are not.** Styling,
but structural: both levels are the same bordered `.plane-details` box, so
"Plane Appearance" inside Planes read as top-level as "3D Mesh Objects" beside
it. `.plane-panel > .info-section > .plane-details` has its existing 1px border
recoloured to the accent, **all four sides**. Not a bar under the title: a
marked header says where a section STARTS, and it is where a tall open one ENDS
that is ambiguous when the next one follows it in a single scrolling column.
Recolouring the border already there, rather than adding a second outline, is
what keeps this from costing content width in a ~300px panel already full of
boxes-within-boxes. The header keeps its own tint, so a folded section still
says what it is. Danger Zone is outlined the same way in the error colour — it
must not pick up the accent, since the point of the red is that it does not look
like its neighbours; that rule is restated at this selector's specificity
because `.plane-panel > .info-section > ...` would otherwise win.

Coverage: `tests/e2e/plane-section-state.mjs` — the reload round trip, that a
repaint does not reopen what the user just collapsed, the Danger Zone negative
control, that nothing reaches the project metadata or the dirty flag, and a
context whose `localStorage` throws.

### ui/lazy-select.js

**Purpose.** A `<select>` that builds its full option list only when the user
reaches for it — the info panel's per-row Track dropdown, which `updateFrameInfo`
rebuilds on every update (see `ui/info-panel.js` ▸ "The Track `<select>` is
built LAZILY" for the measurement that motivated it).

A **LEAF module** — it imports nothing — so the browser suite bridges it
(`window.__LazySelect`) without loading the app.

**Key exports.**
- `buildLazySelect({ head, tail, value, label, entries, cssText })` — returns a
  select holding `head`, the entry `[value, label]`, and `tail`, with `value`
  selected. The middle option is omitted when `value` is the head's or the
  tail's, or when `label` is `undefined` — meaning no entry has that value, so
  nothing is selected, exactly as an eager select would show. On the first
  `mousedown` or `focus` it calls `entries()` once and inserts every
  `[value, label]` between head and tail, keeping the selection.

Three things about it:
- **`mousedown` AND `focus`.** Both fire before the browser opens the list
  (mouse) or acts on a key (keyboard), so the user always picks from the
  complete list, in the eager order. Script that assigns `.value` without
  either selects nothing — as on any select lacking that option; dispatch
  `focus` first.
- **Filling locks the closed width** (`style.width = offsetWidth`) before
  inserting, so a long track name does not widen the select under the pointer
  as its list opens.
- **The caller supplies `label`**, not the helper, so finding the current
  entry's label never builds the list the helper exists to avoid.

**Imported by.** `ui/info-panel.js`.

Coverage: `tests/test-lazy-select.js`, `tests/e2e/info-panel-many-tracks.mjs`.

### ui/panel-visibility.js

**Purpose.** The single answer to "is the 3D viewport / info panel actually on
screen?", plus the deferred-refresh bookkeeping that makes skipping work while
hidden safe. Both collapsible right-hand panels used to be pure CSS —
`toggle3DViewport` / `toggleInfoPanel` flipped a `collapsed` class and no code
doing 3D rendering or panel population ever learned about it — so a hidden 3D
viewport kept rendering at full frame rate and a hidden info panel kept
rebuilding its instance / reprojection-error tables on every frame. Hiding a
panel is how the user asks for that work to stop, so the collapse state has to
be readable by the code doing it.

**Key exports.**
- `isViewport3DVisible()` / `isInfoPanelVisible()` — read `#viewport3dContainer`
  / `#infoPanelWrapper`. The **DOM is the source of truth** (no mirrored
  boolean to drift from the class the CSS reacts to). A `collapsed` class, or
  `display:none` (the 3D container's Three.js-init-failure state), means
  hidden. A **missing element means visible**: the unit-test runner has no app
  chrome, and silently skipping every refresh there would turn these gates
  into invisible test failures.
- `markInfoPanelStale()` / `consumeInfoPanelStale()` — read-and-clear flag.
  Every info-panel populate function is a stateless full rebuild from current
  `state`, so one call on re-show catches up on any number of skipped ones;
  the flag exists so re-showing a panel that never went stale doesn't pay for
  a redundant rebuild (`populateVideosTable` walks every frame of the session).
- `markViewport3DSkipped()`, `skipped` (`{ infoPanel, viewport3d }` counters,
  also on `window.__lucidPanelVis`) — diagnostics. A visibility gate that
  looks right and still does the work has no visual signature at all, so the
  counters are what `tests/e2e/panel-toggle-independence.mjs` reads.
- `collapseViewport3D(viewport3d)` — collapse the 3D panel if expanded (no-op
  otherwise; returns whether it did): park the inline width, add `collapsed`,
  `viewport3d.setVisible(false)`. The collapse half of `toggle3DViewport`, which
  calls it; it lives here so `pose/tracker.js` can close the panel after Track
  All without importing `ui/ui-wiring.js` (an import loop). The viewport is a
  PARAMETER, not an import, to keep this module a leaf.

**Imports from project modules.** **None — this is a leaf module by design.**
`ui/info-panel.js`, `ui/ui-wiring.js` and `pose/initialization.js` all need to
ask it, and several of those already import each other, so any import here
would close a cycle.

**Imported by.** `ui/info-panel.js` (gates `updateInfoPanel` /
`updateFrameInfo`), `ui/ui-wiring.js` (`refreshInfoPanelAfterShow`,
`toggle3DViewport`), `pose/initialization.js` (gates `update3DViewport` and
`setup3DViewport`), `pose/tracker.js` (`collapseViewport3D` after Track All).

**Note.** `ui/viewport3d.js` deliberately does NOT import this — it takes a
per-instance `visible` flag instead, because the export modals mount their own
`Viewport3D` instances that must render regardless of the main panel's state.

**User-facing features.** Hiding the 3D viewport (`\`) or info panel (`I`)
actually stops the corresponding rendering / data work instead of only hiding
its output.

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

### loading/percam-slp-choice.js

**Purpose.** The rule for which `.slp` a camera directory is loaded from, as a
pure function. Imports **nothing** — no project modules, no DOM — so it bridges
into `tests/test-runner.html`. Extracted from `loading/session-loader.js` for
exactly the reason `import-export/import-track-resolve.js` was: session-loader
pulls app.js through its import graph and cannot be loaded there, and a rule
this consequential should be assertable without driving a whole folder load.

**Key export.** `chooseCameraSlp(slps)` → `{file, version, newer}`. See the
`loading/session-loader.js` entry for the rule and why `lastModified` is
deliberately NOT authoritative. `newer` is the most-recently-modified candidate
when that is not the chosen file, else `null` — the signal that a leftover
`_vN` is outranking a file the user just wrote.

**Imports from project modules.** None (deliberately).

**Imported by.** `loading/session-loader.js`, which re-exports it so its own
import site is unchanged; bridged into the test runner as
`window.__PerCamSlpChoice`.

**Tests.** `tests/test-percam-slp-choice.js`.

---

### loading/calibration-pick.js

**Purpose.** Two small facts about calibration FILES that several modules need
and that must not disagree: what the re-based calibration is called, and which
file to load when a folder holds more than one candidate.

**No imports, deliberately.** `loading/session-loader.js` reaches Three.js
through a CDN specifier and `import-export/file-io.js` pulls in the browser
world, so neither can be loaded by a Node test — and the selection rule below
is exactly the kind of thing that wants a unit test. It is also outside the
`ui/origin-rebase.js` / `ui/origin-definition.js` cycle, where a `const`
exported from either and imported by the other sits in TDZ for whichever side
initializes second.

**Key exports.**
- `REBASED_CALIBRATION_NAME` — `'calibration-rebased.toml'`, the file BOTH
  origin actions write. They produce byte-identical TOML for a given origin
  (same cameras, same `rebaseExtrinsics`, same writer); what differs is whether
  the project moved to match, which is a property of the project and not of the
  file. Deliberately not `calibration.toml`: that one is usually shared with
  tools outside LUCID and neither action's business to rewrite.
- `pickCalibrationFile(matches)` → `{file, ambiguous}`. Prefers
  `REBASED_CALIBRATION_NAME` (case-insensitively — a case-insensitive
  filesystem can spell it differently), else the lexicographically first match
  so the choice is at least DETERMINISTIC across loads of the same folder.
  `ambiguous` is the NAMES of the candidates it passed over, so a caller can
  say what it used and what it ignored. Does not mutate its argument: the
  loaders keep scanning afterwards.

**Why it exists.** Both folder loaders used to do `calibFile = file` as they
scanned, so with two matches the winner was whichever the enumeration yielded
LAST — an order neither the File System Access API nor `webkitdirectory`
promises. Harmless while a folder could hold one match; that ended when
`Set as New Calibration` began writing a NEW file instead of overwriting
`calibration.toml`. Picking the wrong one is the quiet failure the whole
re-base flow warns about: the stale file parses, every camera loads, every
number looks plausible, and every reprojection is wrong.

**Imported by.** `loading/session-loader.js` (both folder loaders),
`ui/origin-rebase.js`, `ui/origin-definition.js`.

**Tests.** `tests/test-calibration-file-pick.mjs`.

### loading/video-file-pick.js

**Purpose.** Which of a camera's candidate videos is the session recording.
Two rules about calibration-named files that four load paths need and that must
not disagree.

**No imports, deliberately** — the same reason as `loading/calibration-pick.js`:
`loading/session-loader.js` reaches Three.js through a CDN specifier and cannot
be loaded by a Node test at all, and this decision is pure and worth pinning.

**Key exports.**
- `isCalibrationImagesVideo(file)` — the HARD exclusion. True for a clip under a
  `calibration_images/` path segment (matched at ANY depth, so the answer does
  not depend on which directory the user picked as the root). No such file is
  ever the session recording. `session-loader.js`'s `isCalibrationVideoFile` is
  now just this.
- `hasCalibrationStem(file)` — the SOFT signal: a stem ending in `-calibration`
  or `_calibration`. Positional, not about the separator — `calibration-cam1.mp4`
  is not a match.
- `preferNonCalibrationVideos(files, groupKeyFn)` → `{kept, dropped}`. Drops each
  calibration-STEMMED video that has a non-calibration sibling under the same
  group key. Order-preserving, does not mutate its argument, and a file whose key
  is null is never dropped (nothing says it is redundant).
- `matchVideoToCamera(file, cameraNames, refBaseByCam)` — the camera a video
  belongs to, by parent directory, then the camera name ANYWHERE in the stem,
  then the filename the project references for that camera. All case-insensitive;
  null when nothing matches. Used both to assign a camera and, in the same load,
  as the group key above — matching twice with two different rules is how a video
  gets dropped for one camera and bound to another.

**Why it exists (#199).** The stem used to be a hard exclusion sharing one
predicate with the path rule, so `cam1-calibration.mp4` — an ordinary session
video an alpha tester had simply named that way — was dropped outright and the
folder load produced ZERO views with no message saying why. On the real session
folders all 38 calibration clips live under `calibration_images/` and none
outside it, so the stem rule excluded only false positives. It is now a hint
about which of several candidates is the recording, never proof that a file is
not one.

**The grouping is per CAMERA, not per folder.** That is the scope in which "is
there a better candidate?" is a meaningful question; a folder-wide rule would let
one camera's plain video suppress another camera's only video.

**Imported by.** `loading/session-loader.js` (the per-camera folder loader, the
single-SLP folder loader, and `attachVideosForLazyReopen`),
`import-export/slp-import.js`.

**Tests.** `tests/test-video-file-pick.mjs` (the rules),
`tests/e2e/calibration-named-videos-load.mjs` (both real loaders; confirmed to
fail on the pre-fix build, each loader on a different half).

### loading/track-union.js

**Purpose.** What `session.tracks` IS for a per-camera session folder, where
every camera's `.slp`/`.h5` carries its own track list, as one pure rule shared
by all three per-camera paths: the eager loop in
`handleLoadSessionFolderPerCamera`, `SioLazyLoader` and `LazyFrameLoader`.

**The decision.** `session.tracks` is **the union of the cameras' track NAMES,
cameras taken in sorted camera-name order, each camera's names in its file
order**, and every camera's own track index is re-expressed as an index into
it. Per-camera track lists were considered and rejected: every consumer of a
trackIdx indexes ONE list — overlays (`session.tracks[trackIdx]` names,
`getTrackColor(trackIdx)`), the info panel's Track select, the Tracks Timeline
(`_buildTrackSegments`, keyed per camera but named from `session.tracks`), the
export modal's track stats and Custom Delete's track filter (both aggregate
`forEachInstanceRow` track values ACROSS cameras), `remapTracksFromIdentity`
(treats the column as `session.tracks` indices), and the streaming writer — so a
per-camera list would mean giving every one of them a camera argument.
Concatenation (one block per camera, as the streaming writer used to produce)
was rejected too: it is what the eager path never did, it multiplies the list by
the camera count (3,507 entries for the real folder below) with duplicate names,
and it would make `metadata.lucid.hiddenTracks` (saved by NAME) ambiguous.
Merging by name means a name two cameras share is one session track — one index,
colour and Track-select entry. It says nothing about the animal (a raw
per-camera tracker's `track_0` is unrelated across cameras), and nothing needs
it to: the cross-view tracker keys association, `trustTracks` votes and
`frameIdentityMap` by **(camera, trackIdx)**, which any per-camera-injective map
preserves.

**Why it exists.** Both lazy loaders took `trackNames` from whichever camera's
file finished opening FIRST (`open()` runs for every camera in parallel), while
each camera's instances kept indices into their OWN list. On the real folder
`20260713_174659-194366_05mice_flippers` (8 cameras holding 262, 443, 249, 863,
483, 405, 388 and 414 tracks, all `track_0..track_{n-1}`), five loads gave
`session.tracks.length` = 262, 863, 863, 863, 388 — local SSD vs SMB share
changed the winner. A camera with more tracks than the winner had trackIdx
values past the end of the list (Camera3_sideC's 249–862 when Camera2_mid won),
and any camera's names/colours were read off another camera's list wherever
the lists differ. On that data the union is `track_0..track_862` and every map
is the identity, so the fix rewrites no column there.

**Key exports.**
- `unionTrackNames(perCamera)` → `{names, remapByCam}` for
  `[{camName, names}]`. Input order is irrelevant. Names are matched as a
  MULTISET (the k-th `x` of a camera maps to the k-th `x` slot), so a camera
  that repeats a name keeps distinct tracks and every per-camera map is
  injective. Camera names compare by UTF-16 code unit (`<`), so the order is
  locale-independent.
- `remapTrackIdx(remap, ownIdx)` → session index or `-1`. Trackless stays
  trackless, and so does an index OUTSIDE the camera's own list — what
  sleap-io's lazy materializer always made of one (`tracks[id]` undefined → no
  track). Keeping it raw would name whatever session track sits at that index.
  Accepts an `Int32Array` or a plain object map.
- `isIdentityRemap(remap)`.

**Imports from project modules.** None (deliberately) — loads in Node.

**Imported by.** `loading/session-loader.js` (the eager per-camera loop and
`addColumnarFramesToSession`), `loading/sio-lazy-loader.js` (`_unifyTracks`),
`pose/triangulation.js` (`LazyFrameLoader._unifyTracks`,
`denseOccupancyToSparse`, `_remapFrameTracks`).

**Tests.** `tests/test-track-union.mjs` (the rule, incl. 200 orderings of the
real folder's shape), `tests/test-lazy-track-union.js` (`LazyFrameLoader`
through its real `onmessage`, all six metadata orders),
`tests/e2e/percam-track-union.mjs` (the real folder loader, lazy in all six
open-resolution orders plus eager, the store, occupancy and the streaming
writer's header). The e2e file and the `LazyFrameLoader` tests were confirmed
to FAIL on the pre-fix build.

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
  `attachVideosForLazyReopen`. Also `addColumnarFramesToSession` (the
  per-camera load's Instance builder from the SLP worker's columnar result;
  exported for `tests/e2e/slp-import-fast-compound.mjs`).
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
- `isCalibrationVideoFile(file)` — true for per-camera calibration clips,
  identified by a `calibration_images/` PATH segment
  (`<cam>/calibration_images/<date>-<cam>-calibration.mp4`). The folder scans
  recurse into camera subfolders, so these clips would otherwise be collected
  and substring-matched to a camera (their filename embeds the camera name).
  Applied in the parent-directory pick (both FSA + webkitdirectory branches),
  the "Select Session Folder" scan, and the SLP-import video filter so the
  calibration video never loads as a session view. Now a thin re-export of
  `isCalibrationImagesVideo` (`loading/video-file-pick.js`): it used to ALSO
  exclude any `-calibration` / `_calibration` filename stem, which silently
  dropped ordinary session videos named that way (#199). That stem is now a
  per-camera de-prioritizing hint — see `preferNonCalibrationVideos`, applied by
  the per-camera folder loader, the single-SLP folder loader,
  `attachVideosForLazyReopen` and the SLP import.
- View/grid: `createViewForVideoFile`, `removeVideoFile`, `updateGridLayout`,
  `createVideoPromptCell`, `fitCanvasesToCells`, `cellResizeObserver`,
  `rebuildVideoController`, `updateTotalFrames`.
  `removeVideoFile(videoFile)` is `createViewForVideoFile`'s inverse and the
  whole of the Videos tab's **Remove Video** (luc3d #216): it closes the dock
  pane (`paneManager.removeVideoPanel`), drops the view from `state.views` —
  which is what takes the view-strip thumbnail with it — splices
  `state.videoFiles`, **remaps every session's `videoFileIndices`** across that
  splice (they are indices INTO `state.videoFiles`, so a stale one re-points a
  session at its neighbour's video on the next switch), `close()`s the decoder
  and removes it from `state.decoderPool`/`_decoderPoolCold`, then resettles
  everything derived from the view list. The old handler removed only the
  view's `.video-cell` ELEMENT, leaving the pane docked and titled with an empty
  body plus a live thumbnail. The session's CAMERA is deliberately kept — it
  carries the calibration and the annotations; "no video loaded for this camera"
  is an ordinary state that `recomputeUploadedCameras` already models. Accepts a
  `{name, assignedCamera}` descriptor too, since the Videos table synthesises
  rows from `state.views` when `state.videoFiles` is empty. Covered by
  `tests/e2e/videos-panel-buttons.mjs`.
  **It re-seats `state.singleViewIndex` BY NAME, not by clamping.** That index
  is a position in `state.views`, so removing a video that sits BEFORE the
  solo'd one slides the next camera into its slot — a clamp only catches a
  dangling index, so solo silently showed a different view from the one the
  user put it on. The solo'd view's name is noted before the splice and the
  index re-derived from it; removing the solo'd view itself has no right
  answer, so that case falls back to the clamp AND re-renders the dock
  (`updateVideoGridDisplay`), since the pane just closed was the only one and
  single-view mode would otherwise be left showing nothing.
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
needing to check the console or set anything manually. A decoder that dropped
its backend ON PURPOSE because this browser's WebCodecs cannot decode the
codec (`decoder._mbUnavailable.reason === 'codec'` — Firefox + HEVC, see
`loading/video.js`) gets its own clause instead: `N of M camera(s) step with
<video> seeks: this browser cannot decode HEVC with WebCodecs, so stepping is
slower` — not "init failed … a frame or two off", which is neither the cause
nor (since the mid-frame seek) the measured result. Both clauses can appear,
joined by `; `.

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

**Load progress.** `handleLoadSessionFolderPerCamera` drives the shared overlay
bar (`ui/loading-overlay.js`) through up to three labelled steps: **1** "Parsing
annotations: k/N cameras" (eager) or "Opening annotation files" (lazy), counted
as each camera's worker result / lazy open resolves; **2** "Building session:
k/N cameras", the main-thread build loop, which yields between cameras on the
pacer's clock; **3** "Loading videos: k/N videos" (omitted when videos are
deferred), painted at N/N with "Preparing instances…" before the synchronous
tail. The video decoders are opened **in parallel**: every camera's
`decoder.init` is started up front (each promise resolves `{decoder}` or
`{error}`, never rejects), and the per-camera loop awaits its own camera's
promise in place of calling `init`, so every side effect (videoFiles, views,
decoderPool, cameras, totalFrames, fps) still happens in camera order — the same
pattern as `switchSession`. With the metadata-only frame index (see
`loading/video.js`), all 8 HardFight decoders finish opening in ~0.46 s; the
rest of the step (~0.45 s) is the synchronous "Preparing instances" tail.
Measure with `_bench-progress-overlay.mjs PROFILE_VIDEO=1`. Measured on
HardFight_1kModels: ~0.35 s / ~0.5 s / ~0.9 s of a ~1.8 s load (it was 72 s
before the worker's fast compound reads and columnar transfer — see
`loading/slp-import-worker.js`). Step 2 builds each camera's Instances straight
from the worker's columnar result via the exported
**`addColumnarFramesToSession(session, camName, columnar, trackRemap)`** —
the same track remap / `resolveImportTrackIdx` / `score || 1.0` / occlusion as
the nested-`frames` loop it replaced (kept for results without `columnar`), with
each Instance given its own `Float64Array` `slice` (not a `subarray` view, which
would pin the whole camera buffer and make any structured clone of the instance
copy all of it). A digest of the loaded session (every frame, camera,
instance, coordinate, occlusion bit, track, type, score) is identical to the
pre-change loader's on HardFight (`_bench-progress-overlay.mjs DIGEST=1`).

**Per-camera `.slp` selection.** `handleLoadSessionFolderPerCamera` loads only
**one** `.slp` per camera directory — the highest `_vN` version (first-wins on a
tie / when unversioned). A camera dir accumulates successive exports
(`<stem>_v1.slp`, `_v2.slp`, …, e.g. from "Export SLEAP File Per Session"); only
the latest reflects current state. Parsing every file stacked all versions'
instances into the same (frame, camera) slot — the Instances tab then showed the
same tracks repeated N times. Skipped files are logged.

The choice itself lives in **`loading/percam-slp-choice.js`**'s
`chooseCameraSlp(slps)` → `{file, version, newer}` — extracted from this module
for the same reason `import-export/import-track-resolve.js` was: session-loader
pulls app.js through its import graph and cannot be bridged into
`tests/test-runner.html`, and this rule is worth exercising in the fast browser
suite rather than only through a full folder load. session-loader re-exports it,
so its import site is unchanged. Covered by `tests/test-percam-slp-choice.js`.

It adds two things to a bare max():

- **`lastModified` breaks a same-version tie**, which folder-enumeration order
  used to settle arbitrarily.
- **It reports when the version suffix disagrees with the disk** (`newer`, the
  most-recently-modified candidate when that is NOT the chosen file; `null`
  otherwise, including on equal mtimes so a folder copied in one go stays
  quiet). "Highest `_vN`" is a naming convention, not a fact: since "Export
  SLEAP File By Cam" writes `<stem>_v<N+1>.slp` every time, writing fresh
  annotations to the UNVERSIONED name — which is what "replacing the .slp file"
  means when the original had no suffix — makes a leftover `_v1` win, and the
  console line called that stale file "highest version". The version rule is
  deliberately UNCHANGED (mtime survives neither copying nor syncing reliably,
  so it must not decide which file is authoritative); the load now just says a
  newer file was left unread. Covered by
  `tests/e2e/percam-slp-choice-and-failure.mjs`.

**Large `.slp` → lazy loading.** In `handleLoadSessionFolderPerCamera`, the
chosen `.slp` files are routed by `shouldUseLazySlp` (`> 150 MB`): large
prediction files go to a `SioLazyLoader` (`./sio-lazy-loader.js`, sleap-io.js
streaming lazy reader) instead of the eager `parseSlpH5` worker, which OOMs the tab
on 100k-frame predictions. The lazy loader is chosen when all lazy jobs are `.slp`
(analysis `.h5` folders still use `LazyFrameLoader`); a lazy-open failure surfaces
an error rather than falling back to the OOM-prone eager path. It plugs into the
existing `state.session.lazyLoader` seam, so rendering/scrubbing are unchanged.

**One `session.tracks` for the folder, whichever path and whichever file
opens first.** Each camera's file has its own track list; the session's is
their union in camera-name order, each camera's indices mapped into it
(`loading/track-union.js` has the rule and the reasons). The eager loop builds
that union from every parse result BEFORE adding any camera's instances and
maps each through `remapTrackIdx` (an index outside the camera's own list
becomes trackless instead of staying raw); it used to merge in calibration
camera order as it went, and to keep an out-of-list index as is. The lazy
branch takes `lazyLoader.trackNames`, which both loaders now build the same way
— they used to take the list of the first camera to finish opening (262 / 863 /
388 tracks across loads of one real 8-camera folder), with every other camera's
indices still in its own list. The dead `else` that appended lazy names to an
eager session's list (impossible since the per-folder routing below) is gone.
Covered by `tests/e2e/percam-track-union.mjs` (all six lazy open orders and the
eager path give the same list; confirmed to fail pre-fix).

**The routing decision is per FOLDER, not per file.** Deciding per file let one
folder come back part eager and part lazy, and that combination is silently
lossy: the eager cameras populate `session.frameGroups` during load, and
`ensureLazyFrameData` skipped any frame that already had a FrameGroup — so the
lazy cameras were **never hydrated, on any frame, ever**. Every pane rendered
and only some carried annotations, under a "Loaded N camera(s)" success line.
This is the reported "I exported the .slp files, put them back in the session
folder, reloaded, and only some of the views came back": replacing prediction
files with LUCID exports is exactly what moves a camera across the fixed 150 MB
threshold, which is why it appeared on a reload and not on the original load.
Measured on a 3-camera folder: all-eager 12/12/12, all-lazy 12/12/12 after
scrubbing, **mixed 0/12/12** — and the zero never recovered.

The unification goes toward **LAZY, never toward eager**: eager is what OOMs the
tab on a 100k-frame prediction, so pulling a big file onto that path to match a
small sibling would trade a display bug for a crash. A small file on the lazy
path just hydrates on scrub. An all-small folder is untouched — it still loads
eagerly, with its data present immediately and no scrub needed.
`pose/triangulation.js`'s `ensureLazyFrameData` independently repairs a
partially-hydrated frame now, so a mix arriving some other way degrades rather
than losing views. Covered by `tests/e2e/percam-mixed-lazy-eager.mjs`, which
asserts all three routings plus the repair path and its idempotence (all four
assertions confirmed to fail pre-fix).

**A `.slp` the reader chokes on is reported, not swallowed.** The parse was
`parseSlpH5(bestSlp).catch(function (e) { return null; })` followed by `if
(!slpData) continue`, and the closing status counts matched DIRECTORIES rather
than successful parses — so an unreadable file left that view empty under a
success-styled "Loaded N camera(s)", the third way to lose a view with nothing
said anywhere. Failures are now collected per camera and named in the status
line, which downgrades to `error`. Note the root cause was one level down: `new
h5wasm.File(path, 'r')` does NOT throw on non-HDF5 bytes — it returns a File
wrapping an invalid id (the tell is HDF5-DIAG `H5Fclose(): not a file ID`) —
and since every `f.get()` in `loading/slp-import-worker.js` is individually
try/caught, parsing ran to the end and posted an ordinary result with 0 frames.
The worker now checks `f.keys()` right after the open and throws
`Not a readable HDF5/SLP file (no root datasets)` on an empty/unreadable root,
so the failure reaches every caller as a rejection instead of a successful
parse of nothing.

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
  `../ui/browser-hints.js` (`fileSystemAccessHint` — Brave hint in the
  multi-session "needs a folder picker" message), `./video.js`, `../import-export/file-io.js`, `../pose/triangulation.js`
  (`shouldUseLazyH5`, `shouldUseLazySlp`, `LazyFrameLoader`),
  `./sio-lazy-loader.js` (`SioLazyLoader`),
  `./track-union.js` (`unionTrackNames`, `remapTrackIdx`),
  `../import-export/save-load.js`,
  `../ui/rendering.js` (`drawAllOverlays`, `setReprojErrorVisible`),
  `../ui/info-panel.js` (`updateInfoPanel`, `promptImportSkeletonForAllSessions`),
  `../ui/calibration-notice.js` (`noteSessionCalibrationDivergence`),
  `../ui/frame-readout.js` (`refreshReadoutTotals`, wherever the loaders set
  `state.totalFrames` / `state.fps`),
  `../import-export/skeleton-json.js` (`parseSkeletonJSON`),
  `../import-export/slp-import.js`, `../ui/loading-progress-modal.js`,
  `../ui/loading-overlay.js` (`showLoadingProgress`, `createProgressPacer`,
  `yieldToPaint` — the per-camera folder load's step progress),
  `../import-export/import-track-resolve.js`,
  `../pose/initialization.js`, `../ui/sessions-panes.js`, `../ui/ui-wiring.js`,
  `../import-export/visibility-metadata.js` (`readVisibilityMetadata`, for the
  lazy-reopen read of the session-scoped Visibility settings).

**Imported by.** `pose/initialization.js`, `import-export/save-load.js`,
`import-export/slp-import.js`, `ui/info-panel.js`,
`ui/sessions-panes.js`, `ui/ui-wiring.js`.

**`handleLoadMultiSession` ends with a calibration cross-check.** Each session
subfolder carried its own calibration and nothing made them agree, so the tail
calls `noteSessionCalibrationDivergence(state.sessions)` — LAST, once every
session is in `state.sessions`, because comparing while they are still arriving
one at a time reports a divergence the next session resolves, and a modal raised
mid-load would sit over the loading overlay. It is queued behind the skeleton
prompt (passed as that prompt's `onDone`) for the same reason: two stacked
modals, and the user answers whichever is on top. See
`ui/calibration-notice.js`.

**User-facing features.** File menu Load Calibration / Load Videos /
Load Session Folder / Load Multi-Session (plus the lazy Load Project path for
large project `.slp`s, incl. its attach-videos prompt), all video-to-camera
auto-matching, session-folder mode chooser. `handleLoadSessionFolder` calls
`ensureNo3dImportBlockingLoad()` first, so loading a session over a
skeleton-only 3D-points import prompts before discarding it.

---

**Video load failures are surfaced, with the reason.** Every loader reports a
video the browser couldn't play via `videoLoadFailureText` (the decoder's codec
diagnosis when there is one). The per-camera session-folder path used to log
such failures to the console only — poses loaded with no video and no message
(e.g. Safari + `hev1`-tagged HEVC); it now collects them in `videoFailures`
and appends them to the final status (one line per distinct diagnosis), like
`slpFailures`. Lazy reopen's attach step lists the reason per file too.

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
metadata + builds a videoFrameIdx→store-row map; the skeleton is the first
camera BY NAME's and `trackNames` is the union over every opened camera, with
each store re-indexed into it — see "Track indices" below — so nothing depends
on which parallel open resolves first; returns THIS camera's own track names),
`openProjectSlp(file, onProgress)` (lazy reopen of a SINGLE multi-camera
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
(adapt typed instances → `{trackIdx (-1 = none, as in the store; hydration
maps it to `null`), score,
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

**Track indices: one list, every store re-indexed into it (`_unifyTracks`).**
`session.tracks` for a per-camera folder is the union of the cameras' own track
names, cameras in name order (`loading/track-union.js` has the rule and why).
`open()` used to set `trackNames` from whichever camera's open resolved FIRST
and leave every store holding its own file's indices — nondeterministic
(262/863/388 tracks across loads of one real folder) and wrong for every other
camera (indices past the end, names from another camera's list). Now `open()`
records the camera's OWN names in `_trackSourceByCam` (`{names, toSession}`,
`toSession` = the session index each own track currently holds) and calls
`_unifyTracks(newCam)`, which re-derives the union FROM THE OWN NAMES (never
from a previous union — that would make the result order-dependent) and, per
camera: rewrites `instancesData.track` through the old map's inverse when its
indices moved (always for the new camera, whose out-of-list values become `-1`
rather than coming to name an appended track); rebuilds `labels.tracks` IN
PLACE to the union (shared with `_lazyDataStore.tracks`; own `Track` objects
kept at their new indices); recomputes that camera's occupancy if its column
changed, else just updates `nTracks`; clears the frame caches it invalidated.
After it, every column value is a `trackNames` index in every camera, which is
what `adaptTypedInstance`, `forEachInstanceRow`, `_computeSparseOccupancy`,
`remapTracksFromIdentity`, Custom Delete and the streaming writer all assume —
and since every camera's `labels.tracks` is then the same name list, the
writer's name-signature dedup writes the tracks ONCE (it used to write one copy
per camera: 14 tracks for a 9-track union in the e2e fixture). On the real data
(every list `track_0..track_{n-1}`) every map is the identity, so the cost is
one read pass over each camera's track column. `reopenSessionLazyLoader`
(multi-session save, pass 2) re-opens through the same `open()`, so it
re-derives the same columns — which is why `_unifyTracks` does not set
`_storeEditedInMemory`, while `remapTracksFromIdentity` and
`deleteInstanceRows` do (the multi-session save then keeps the live frame +
instance columns for pass 2; see `import-export/save-load.js`). `close()`
clears it. `remapTracksFromIdentity` resets each camera's
own names to the propagated list (and `trackNames` with it), so a later
`_unifyTracks` starts from that. Covered by `tests/e2e/percam-track-union.mjs`.

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

**`deleteInstanceRows(shouldDeleteFn, opts)` — the durable-delete primitive
(Custom Instance Delete, and since the interactive-delete fix every Delete key /
"Delete group" too, via `deleteTargetsFromStore` in `ui/custom-delete-ops.js`).**
Permanently removes instance rows from the columnar store so a delete survives
eviction, re-hydration, save and reload. Companion to
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
- **One keypress must not cost a bulk pass.** Measured on a real-size shared store
  (180,210 frames x 5 cameras, 2.7M rows, 10 f64 columns) a single-row delete was
  130-200 ms and ~216 MB of fresh column buffers; it is now ~25-30 ms with no new
  buffer. Three changes, each pinned by `tests/test-custom-delete-store.js`'s
  "one keypress, not one bulk pass" suite against the old whole-store answers:
  `opts.only` (camName → frame indices, a Map's keys or a Set) offers the predicate
  just those camera-frames' rows; compaction runs **in place from the first deleted
  row** — one `copyWithin` per surviving run when at most `DELETE_RUN_COPY_MAX`
  (4096) rows go (~5 ms vs ~70 ms element by element), the plain loop beyond that,
  where runs are short and many — and a typed column is re-exposed as a shorter
  `subarray` view, or `slice`d to a right-sized copy when more than half the rows
  went so a bulk delete still gives its memory back; and `trackOccupancy` is rebuilt
  only for a camera that LOST a row. In place is safe because every reader indexes
  `store.instancesData.<col>` element-wise and fresh (`appendStore`, the store's own
  `materializeFrame`, `forEachInstanceRow`); an array under two column names is
  compacted once.
- Compacts every `instancesData` column of length `nInst` (iterates `Object.keys`,
  so a schema addition is carried through; the view/`slice` keeps typed-vs-plain
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
- Then rebuilds the `trackOccupancy` of each camera that lost a row and clears both cache layers
  (`this.cache` + `labels._lazyFrameList.clearCache()`), same as
  `remapTracksFromIdentity`.
- **Caller contract:** store-only. The caller must also renumber `_rawInstIndex` on
  surviving instances in each touched (camera, frame) — else `refFor` writes grouping
  refs at the wrong instances and hydration loads the wrong 2D — and mirror the
  removal into `frameGroups`/`instanceGroups` under one shared `seen` Set.
- Unit tests: `tests/test-custom-delete-store.js` (19 cases — compaction, column-length
  coherence, typed-array kind, order-independence, emptied-frame collapse,
  `from_predicted` remap + degrade-to-`-1`, shared-store apply-once, per-row error
  isolation, no-op; plus `opts.only`, both compaction strategies against an
  independent filter, in-place view vs right-sized shrink, aliased columns, and the
  per-camera occupancy rebuild).

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
identity. An optional second argument `{camera, start, end}` narrows the walk
to one camera and/or a frame range (`[start, end)`, visited in ascending frame
order via the row map instead of its iteration order); added for the status
bar's whole-project counters (`ui/frame-counters.js`), which read one camera
and spread the walk over short tasks. Without it the walk is exactly as before.
`remapTracksFromIdentity(newTrackNames, remapFn)` — the write-side
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

**`describeStoreFrame(camName, frameIdx)`** — what re-hydrating one
camera-frame WOULD build, read straight from the columns with nothing
materialized: `{ count, trackIdx: Int32Array, predicted: Uint8Array }` (entry `k`
= the row an `Instance._rawInstIndex` of `k` names; trackless and a track id with
no `Track` behind it are -1; an absent `instance_type` reads as 0, a user row,
exactly as `materializeFrame` defaults it), `count: 0` for a frame with no row,
null for a camera this loader does not back. The playback eviction
(`pose/lazy-residency.js`) proves a resident frame rebuildable against it;
`tests/e2e/lazy-playback-eviction.mjs` pins it to the real materializer.

**Imports.** `./track-union.js` (`unionTrackNames`);
`window.SleapIO.readSlpStreaming` / `window.SleapIO.Track` (via the index.html
bridge) and the local vendored `lib/h5wasm/h5wasm.iife.js` (passed as
`h5wasmUrl`).

**Imported by.** `loading/session-loader.js`
(`handleLoadSessionFolderPerCamera` routing, `handleLoadProjectSlpLazy`) and
`import-export/save-load.js` (`reopenSessionLazyLoader`). `describeStoreFrame` is
called duck-typed from `pose/lazy-residency.js`.

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
- IN: `{type: 'parse', file, slowCompound?, columnar?}` — full eager parse.
  `slowCompound: true` forces h5wasm's `Dataset.value` for the compound tables
  (the equivalence test's reference path; also a kill switch). `columnar: true`
  returns the poses as flat TRANSFERRED typed arrays in `data.columnar` (and an
  empty `data.frames`) — see below.
- IN: `{type: 'open', file}` — lazy open, return metadata only.
- IN: `{type: 'getFrame', frameIdx, requestId}` — read one frame lazily.
- IN: `{type: 'getFrames', startIdx, endIdx, requestId}` — read range.
- IN: `{type: 'close'}` — close lazy file.
- OUT: `{type: 'progress', message}`, `{type: 'result', data: {...}}`,
  `{type: 'metadata', data: {...}}`, `{type: 'frameData', ...}`,
  `{type: 'framesData', ...}`, `{type: 'error', message}`.

**An unopenable file must reject, not resolve empty.** `new h5wasm.File(path,
'r')` does **not** throw on non-HDF5 bytes — it hands back a File wrapping an
invalid id, the tell being HDF5-DIAG `H5Fclose(): not a file ID` on the way out.
Every `f.get()` in `parseSlp` is individually try/caught and returns null on a
missing dataset (correct for optional ones like `tracks_json`/`sessions_json`),
so a truncated or non-SLP file parsed all the way to the end and posted a
perfectly ordinary `result` with 0 frames. Callers could not tell that from a
genuinely empty file: `handleLoadSessionFolderPerCamera` took it as a successful
parse and that camera's view came up blank with nothing said anywhere. `parseSlp`
now checks `f.keys()` immediately after the open and throws `Not a readable
HDF5/SLP file (no root datasets)` when the root is empty or unreadable — an SLP
always has root keys (`metadata`, `videos_json`, `frames`, …) — so the failure
reaches every caller as a rejection. Covered by
`tests/e2e/percam-slp-choice-and-failure.mjs`.

**Fast compound reads (`readCompoundColumnsFast`).** SLEAP-written `.slp` files
store `frames` / `instances` / `points` / `pred_points` as HDF5 **compound**
datasets, and h5wasm's `Dataset.value` turns each row into a JS array of small
TypedArrays (~7 µs per cell). On the HardFight_1kModels set (8 cameras × 36,000
frames, ~1.6M `pred_points` rows per camera) that made "Load Single Session
Folder" take **72 s** — ~58 s in `pred_points` alone, with all 8 workers
allocating millions of tiny arrays at once (one file parsed alone takes ~4.5 s;
eight in parallel thrash). `readColumnar`/`readPoints` now first try
`readCompoundColumnsFast`: one `get_dataset_data` into the WASM heap, then a
DataView decode of each requested member into a `Float64Array` — a port of
sleap-io.js's `readCompoundColumnsWorker` (keep the decode rules in step). Per
file ~0.65 s; the whole load **72 s → ~5 s**. Columns are matched BY NAME (the
`.value` path mapped by position); anything that is not a plain-numeric 1-D
compound containing every requested field returns null and falls back to
`.value`. LUCID's own files (2-D matrix + `field_names`) never take this path.
`tests/e2e/slp-import-fast-compound.mjs` runs both paths on the same file and
requires deep-equal results (`Object.is` per number) — on
`tests/fixtures/slp-compound/sleap-compound-small.slp` (a genuine Python
sleap-io file, regenerable with `make_fixture.py` there), and with `DATASET=`
on every real `.slp` in a folder (all 8 HardFight cameras: identical).

**Columnar result (`buildColumnarFrames`).** The default `data.frames` is ~1.6M
boxed `[x, y]` arrays + ~200k objects per 36k-frame camera, and structured-
cloning eight of them to the main thread was most of what remained of the
session-folder load once the reads were fast (~2 s of ~5 s). With
`columnar: true` the worker instead returns `data.columnar` = `{ numNodes,
nFrames, nInstances, frameIdx, videoIdx, instOffsets (nFrames+1), trackIdx,
score, type (1 = predicted), xy (NaN = missing), occluded }` — the same
frames/instances kept and the same values, as typed arrays whose buffers are
TRANSFERRED (zero-copy) in the `postMessage`. Only `parseSlpH5(file, null,
{ columnar: true })` from `handleLoadSessionFolderPerCamera` asks for it; every
other caller still gets `data.frames`. The equivalence test also requires the
columnar result to expand back to exactly the nested `frames`.

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

### loading/video-codec-diagnosis.js

**Purpose.** Explain WHY the browser refused a video. A `<video>` load
failure only yields "error code 4" (MEDIA_ERR_SRC_NOT_SUPPORTED); this reads
the file's video codec from its MP4 sample description and returns a specific,
actionable message. Measured cases (`tests/e2e/_probe-capabilities.mjs`, macOS
26 / M2 Pro): Safari plays HEVC-in-MP4 only when tagged `hvc1` (`hev1` →
canPlayType "") — a lossless `ffmpeg -c copy -tag:v hvc1` re-tag fixes it;
Safari decodes AV1 only with hardware AV1 (Apple M3+), while Chrome/Firefox
decode it in software; otherwise suggest another browser / converting to H.264.
Reading is cheap on multi-GB recordings: it walks top-level box headers with
random-access reads (`Blob.slice`, or HTTP Range for URLs) and reads only
`moov` (recordings keep it at the END, after the `mdat`). No diagnosis (null)
when the codec can't be read or the browser claims support — the original
error then stands (e.g. a corrupt file).

**Key exports.**
- `sniffMp4VideoCodec(source)` → `{fourcc, codecName}|null` (File/Blob/URL).
- `videoFourccFromMoov(moovBytes)` — first video sample-entry fourcc in a `moov`.
- `explainUnplayableCodec(fourcc, fileName, env?)` → `{fourcc, codecName, kind,
  message}|null`; pure (`env.canPlayType`, `env.isSafari` injectable). Kinds:
  `hevc-hev1-tag`, `av1-unsupported`, `hevc-unsupported`, `unsupported`, `encrypted`.
- `diagnoseUnplayableVideo(source, fileName?, env?)` — sniff + explain.
- `videoLoadFailureText(name, err)` — one-line reason for loaders' status
  messages: `err.codecDiagnosis.message` when present, else the error text.

**Imports from project modules.** None.

**Imported by.** `loading/video.js` (`OnDemandVideoDecoder._awaitPlayable`),
`loading/session-loader.js` (`videoLoadFailureText`).

**Tests.** `tests/test-video-codec-diagnosis.js` (synthetic MP4s: moov at the
end read in < 4 KB, 64-bit box sizes, audio track first, every message kind,
decoder integration); real browsers via the `decoderErrors` step of
`tests/e2e/_probe-capabilities.html`.

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

**`<video>` seeks aim at the MIDDLE of the frame (`html5SeekTime`).**
`_getFrameHTML5` sets `currentTime = (i + 0.5) / fps`, not `i / fps`. A
frame-start time sits on the boundary with frame i−1 and browsers round it
either way: on barcode clips (frame number burned into the pixels, 8 cameras
seeking at once, gitignored `verify/seek-probe.html`), Firefox 157 showed i−1
for every frame with `i % 3 == 2` at 60 and 150 fps (63–70% exact, HEVC and
H.264 alike), Chrome/Brave/Safari for most frames (7–33%). Mid-interval was
exact in all 2,160 Firefox seeks and in every H.264 seek in the other three
(their `<video>` HEVC: 80–90% vs 7–15% — they step HEVC through mediabunny, so
only a decode failure reaches this). Seeking to mediabunny's exact PTS
(`_frameTimes[i]`) is the frame start again and missed identically; the
midpoint of two PTSs matched `(i + 0.5) / fps`. **`requestVideoFrameCallback`
cannot verify a landing in Firefox**: its `mediaTime` echoes the seek target,
not the frame shown (Chrome's does report the shown frame). `seekNativeSettled`
(play start) treats an element parked on the frame's middle as already there:
`(i+0.5)/fps − i/fps` comes out an ulp over half a frame for ~30% of frames,
and re-seeking to the frame start would land on i−1 in Firefox. **Only a
position `_getFrameHTML5` set itself skips the seek** (`_html5Moved`, set by
`playNative`, `seekNative` and a real `seekNativeSettled` seek, cleared by the
next `_getFrameHTML5` seek and by `switchSource`): after playback the picture
need not match `currentTime`, and the +0 pause re-decode (asking for the frame
already under the playhead) drew the NEXT frame on 1 Firefox HEVC pause in 10
by skipping its seek. Measured with the pause harness (gitignored
`verify/pause-xb.html`, 8 cameras, Firefox, HEVC): paused picture == skeleton
for the shipped +1 re-decode 31% → 100%, for +0 28% → 100%.

**A codec WebCodecs cannot decode drops the backend up front
(`_mbCannotDecode`).** Firefox 157 demuxes HEVC — `MediaBunnyVideoBackend`
initializes — but has no WebCodecs HEVC decoder, so every `getFrame` failed
twice (the step stream, then the backend's own `getFrame`) before falling back:
1,544 warnings in one 8-camera stepping run. `_initMediabunny` now asks
mediabunny's `track.canDecode()` (`VideoDecoder.isConfigSupported` on the full
decoder config; ~0 ms) once, AFTER adopting the backend's frame count and fps
(container metadata, still right), and on `false` closes the backend and sets
`_mbUnavailable = { reason: 'codec', codec, codecString }`; a failed init sets
`{ reason: 'init', message }`, and both `init` and `switchSource` reset it.
Measured `false` only for HEVC in Firefox; `true` for H.264 there and for both
in Chrome, Brave and Safari, whose path is therefore unchanged. A check that
cannot be asked answers null, leaving the per-frame fallback to cover it.
End to end (gitignored `verify/step-probe.html`, the real decoder, HEAD vs
this, 8 cameras, Firefox, HEVC 60 fps): exact 67–70% → 100%, fallback warnings
1,544 → 0; step time unchanged within run-to-run noise (8-camera medians
~0.7 s per jump or forward step, ~1.2 s back, both builds — Firefox's own
`<video>` HEVC seek is the cost, and the skipped attempts were cheap). Chrome,
Brave and Safari: identical before and after (mediabunny on every camera, 100%
exact, same step times). With no backend, the image
ID-switch check's `keyframeIndices` / `streamingReader`
(`ui/image-embedder.js`) take their `getFrame` path rather than a stream that
cannot decode.

Covered by `tests/test-mediabunny-backend.js` (stubbed backend: dropped on
`false`, kept on `true`, kept when the question cannot be asked, no per-frame
warning afterwards), `tests/test-html5-seek-tolerance.js` (the mid target, the
play-start parking, the `_html5Moved` rule) and
`tests/e2e/html5-step-mid-frame.mjs` — real Chromium made to answer "cannot
decode" (`VideoDecoder.isConfigSupported` stubbed for the whole run, which
mediabunny also consults before each decode, so a KEPT backend fails every
frame exactly as in Firefox + HEVC), stepping the real decoder forward,
backward and by jumps through `tests/fixtures/barcode-60/barcode-60.mp4`
(4 KB, 60 fps, frame number as a barcode; `make_fixture.sh` regenerates it)
and reading every frame number back. On the pre-fix build it fails with 256
fallback warnings and most steps one frame behind; its control decoder,
seeking to the frame START, must land wrong (89 of 128 headless) or the test
could not tell the targets apart. The fixture is 60 fps on purpose: at 10 fps
(`bframes-test`) frame times are whole microseconds and both targets land.

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
the patch, 0 after. Covered by `tests/e2e/mediabunny-bframe-decode-order.mjs`
(fixture video + PNGs regenerated together by
`tests/fixtures/bframes-test/make_fixture.sh`).

**The frame index is built metadata-only (`luc3d frame-index` patch).** The
same `initialize()` walk used `packets()` with no options, which reads every
packet's payload — the whole 250–350 MB video — only to collect timestamps.
It now passes `{ metadataOnly: true }` (identical packets/order/timestamps,
pinned by `tests/e2e/mediabunny-frame-index-metadata-only.mjs`), so
`_initMediabunny` drops from ~120 ms to ~28 ms per HardFight camera, and the
8-camera session-folder load's parallel decoder opens finish in ~0.46 s instead
of ~1.04 s. See CLAUDE.md's "LOCAL PATCH (luc3d frame-index)".

**`switchSource()` must refresh `_mbBackend` too (issue #115 regression,
`eric/seeking-regression`).** `switchSource(source)` — used by the pooled-
decoder session-switch/reopen path (`ui/sessions-panes.js`'s
`switchSession()`, "reuse pool decoder — swap source without creating new
video element", added to dodge Chrome browser-process crashes from repeated
`<video>` element churn) — predates the mediabunny backend and was never
updated when it landed: it closed the WebCodecs `this.decoder` but left
`_mbBackend` untouched, still bound to the PREVIOUS video. Every
frame-accurate `getFrame()` after a pooled-decoder session switch/reopen
(stepping, the `pausePlayback()` re-decode) then silently decoded from the wrong,
stale video — reproducing the exact pose/video misalignment #141 fixed, but
only on switch/reopen (a fresh `init()` was always fine, which is why this
was hard to pin down from a fresh-load repro). Fixed by closing the old
`_mbBackend` and re-running `_initMediabunny(source)` for the new source at
the end of `switchSource()`, mirroring `init()`'s setup. Covered by
`tests/e2e/switchsource-mediabunny-refresh.mjs` (proves it via decoded pixel
content, not just the backend's `filename`, since the fixture videos happen
to share a frame count).

**The `<video>` `error` listener reads the ELEMENT it was attached to, not
`this._videoEl`.** Both `init()` and `switchSource()` register a `once: true`
`error` listener that rejects their metadata promise. That listener OUTLIVES a
successful load, and `close()` ends with `src = ""` + `load()` — which fires one
last `error` event, asynchronously, after `close()` has already nulled
`this._videoEl`. Reading the code through `self._videoEl` therefore threw
`Cannot read properties of null (reading 'error')` out of an event handler on
every decoder that is CLOSED rather than garbage-collected. Latent until
`removeVideoFile` (luc3d #216) made closing a decoder an ordinary user action;
the cold-pool eviction path hit it too, just invisibly. Both sites now capture
`var el = this._videoEl` at registration and read `el.error`.

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

**Paused stepping keeps a decode stream open (`_mbGetFrame`, 2026-10-04).**
`MediaBunnyVideoBackend.getFrame` opens a fresh decoder per frame and decodes
from the frame's keyframe, so on P-frame recordings with a keyframe every 250
frames EVERY paused frame — an arrow-key step forward included — decoded ~125
frames per camera. `getFrame` now goes through `_mbGetFrame`, which keeps one
mediabunny `sink.samples(t)` stream per decoder (`_stepCursor`: decodes from the
keyframe once, then stays a few frames ahead) and serves any request at or after
its position that needs no newer keyframe (`_sameKeyframeRun`: the target's key
packet, via a lazily created `EncodedPacketSink.getKeyPacket` — `import('mediabunny')`
on first use — is at or before the stream's next frame) by advancing it; a step
back or a jump past the next keyframe reopens it at the target, i.e. the same
decode as before. Results go into the backend's frame cache as `getFrame`'s did,
so stepping back over frames just shown stays a cache hit. Released after
`STEP_CURSOR_IDLE_MS` (3 s) idle, by `releaseStepCursor()` (called for every view
by `VideoController.startPlayback`), `switchSource` and `close`. Any failure
falls back to the backend's own `getFrame`; `window.LUCID_STEP_CURSOR = 0` turns it
off. Measured (M2 Pro, real Chrome, 2-min clips of the 8 cameras of the 5-mouse
recording, all 8 views per frame; `tests/e2e/_bench-step-cursor.mjs`): on the
original recordings (keyframe every 250) a step forward 148 -> **1 ms**, a held
arrow key 2.6 -> **245 frames/s**; re-encoded with a keyframe every 30, 64 -> 1 ms
and 15.6 -> 366 frames/s. Steps back and jumps are unchanged apart from the
stream's read-ahead (~40 extra packets decoded in the background on opening:
jump 206 -> 214 ms, step back 405 -> 421 ms on the originals). Stepped frames are
pixel-identical to the frame-accurate decode. Cost while paused: each open stream
holds its few read-ahead frames (and a decoder) until it idles out.
**Stepping BACK decodes in chunks (`_decodeBackChunk`, 2026-10-05).** A frame can
only be decoded forward from its keyframe, so each step back re-decoded the whole
run from the keyframe — up to 250 frames per camera, ~420 ms for 8 views, and
choppy (cheap just after a keyframe, dear just before the next). When a request is
1–3 frames before the previous one, `_mbGetFrame` instead decodes that run once
and caches up to `STEP_BACK_CHUNK` (24) frames ending at the target, never earlier
than its keyframe, so the next steps back are cache hits. Capped at 40% of the
frame cache (60 in the app), so the chunk on screen and the one being prefetched
both fit; `window.LUCID_STEP_BACK_CHUNK = 0` turns it off.
**Background prefetch + landing warm-up.** While stepping back, `_prefetchBack`
decodes the chunk before the cached run in the background (its own decoder, not
under `_mbSeekLock`; one at a time; a request for a frame it is decoding waits for
it), and `_scheduleBackWarm` does the same `STEP_BACK_WARM_MS` (250 ms) after the
user LANDS on a frame by a jump (seekbar, a flagged switch, end of playback) and
stays — counted from when the frame is shown, so back-to-back jumps never start
one. Anything but a step back cancels it (`job.cancelled`, checked per decoded
frame; `releaseStepCursor` too). Chunk frames are cached by `_cacheNear`, which
evicts the frame FARTHEST from the user rather than the least recently used:
stepping back, the not-yet-reached prefetched frames ARE the least recently used,
and LRU evicted exactly them (a hitch every ~30 steps).
`window.LUCID_STEP_BACK_PREFETCH = 0` turns prefetch and warm-up off.
Jumps and seekbar drags (larger moves) don't trigger it. Held left arrow, 72
steps, 8 views, original recordings (`_bench-step-cursor.mjs`, app cache 60):
2.3 -> **34.6 steps/s**, median step 428 -> 0 ms, but every 24th step costs ~0.7 s
(the run + 24 bitmaps per camera); keyframe every 30: 15.1 -> 70.1 steps/s, worst
step ~240 ms. With prefetch + warm-up, landing then holding the key at 30 steps/s:
**0 of 72 steps over 50 ms** (29.8 steps/s achieved; chunks alone: 3 hitches of
~0.5–0.6 s), keyframe every 30 also 0 (chunks alone: 4); stepping as fast as
frames come, 45.7 steps/s, where it can outrun the prefetch. Jumps unchanged
(208 -> 215 ms). Memory: the cache peaks at its existing ceiling (60 frames per
camera, 480 here) with or without chunking — chunking fills it sooner, it does
not raise it. Stepped-back frames pixel-identical to the unchunked decode. Guarded by
`tests/e2e/step-cursor.mjs` (one packet per step vs every frame since the
keyframe, pixel-identical stepped / stepped-back / jumped frames, reopening at the
right keyframe, chunked back steps — 2 of 30 steps decode, same frames — the
landing warm-up, a held left arrow finding 120/120 frames already cached in a
30-frame cache (111/120 with plain LRU eviction, which the test was checked to
fail on), cancellation by a jump, and release on idle / request / close).

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
`updateSeekbar`, plus per-frame `[3D]` `console.log` spam (now gated behind
`window.LUCID_3D_DEBUG`). With those coalesced to ~10 Hz during playback, the
native `<video>` + `requestVideoFrameCallback` overlay keeps up
frame-to-frame. **Native playback is the default** (smooth);
`VideoController.stopPlayback` fires a final unthrottled overlay/seekbar
update so the info panel and timeline settle to the exact stop frame.
*Later (playback-choppiness work, measured with
`tests/e2e/_bench-playback.mjs`):* the 10 Hz tail itself was still ~18 ms and
dropped ~18% of video frames, so it was cut down — status-bar counters skipped
while playing (`ui/info-panel.js`), timeline playhead-only redraw
(`ui/timeline.js`). The 3D viewport is **no longer throttled**: its 10 Hz
updates made it jump 6–7 frames at a time, and `updateSkeleton` is now an
in-place pose update cheap enough to run on every frame (`ui/viewport3d.js`).
**The native loop is now per-refresh** (`_playbackLoopMode() === 'refresh'`,
default): on every `requestAnimationFrame` it captures each view's current
frame (`decoder.captureCurrentFrame()` → `new VideoFrame(<video>)` + the index
from that frame's own timestamp), `drawImage`s exactly that frame, and calls
`drawOverlays(mainIdx, viewFrames)` so each view is overlaid at its own frame;
a refresh where no view's frame changes draws nothing, captures are always
`close()`d (held ones on `stopPlayback` via `_refreshCleanup`), and playback
stops when the primary `<video>` ends. **Browsers whose `VideoFrame(<video>)`
timestamps don't track the picture** (Safari 27: 0, or an exact copy of
`currentTime`; Firefox 157: a constant) are detected per decoder by
`judgeVideoFrameTimestamps` (the timestamp must move, agree with the clock
within max(3 frames, 50 ms) — 3 frames alone misjudged Chrome/Brave at 150 fps
on 60 Hz, where the presented frame trails the clock by more — and not BE the
clock: equal to `currentTime` to the µs while off the frame grid; cached as
`decoder._vfTimestamps = 'ok'|'bad'`). **WebKit never captures at all**
(`videoFrameCaptureUnsafe()`, an engine check like `rvfcCallbacksCoalesced`):
Safari's capture timestamp is 0 or an exact copy of `currentTime` and named the
captured picture in 0–3% of captures, yet a clock reading can pass judging (the
old judge passed it at 150 fps: picture 1–13 frames behind the overlay), and
drawing captures cost ~25% of Safari's presented pictures. While a view is
still being judged it is not drawn (its canvas keeps the paused frame). A
`'bad'` view stops capturing (also avoiding Firefox's 5–11 ms/refresh capture
cost), is painted with `drawCurrentFrame`, and is indexed from a per-view
requestVideoFrameCallback: **Safari** (one callback per shown picture) is
painted INSIDE the callback at its `mediaTime` (where `drawImage` and
`mediaTime` are the same frame; by the refresh a 150 fps video can be 1–2 on),
but only once the reported frame first changes — the first callback after the
pre-play seek carries the pre-seek frame's metadata. **Firefox** (coalesced,
~24 callbacks/s: `rvfcCallbacksCoalesced()`) is painted on the refresh and
indexed by a **`CoalescedFrameClock`** evaluated at the instant of the draw:
Firefox paints the last queued frame due by `TimeStamp::Now()`, and each
callback bounds that frame's due time to one refresh (`expectedDisplayTime ==
now` → the refresh before, `> now` → the refresh after), so the intersection
says when a draw is CERTAIN. With ≤ ~½ frame per refresh (60 fps on 120 Hz)
the loop skips an uncertain refresh when the next would be certain (≤ 2 in a
row) — the frame lands a refresh later, cadence unchanged; with more (60 fps
on 60 Hz, where every bound is a whole refresh wide; 150 fps) it draws the
midpoint guess. A Firefox estimate never steps backwards. With no rVFC, the
clock. (Tried and dropped: at 60 Hz, deferring Firefox's draw to a timer just
before the next vsync raised 60 fps alignment to ~70–85%, but Firefox's timers
slip under load and 8 cameras fell to 48–56 distinct frames/s, below the old
loop's 58.6.) **Until a fallback view's first usable callback its index is unknown
and it is not drawn**: its canvas still shows the paused `startFrame`, which
is what it is overlaid at — the clock is no stand-in (after a seek Safari kept
painting the PRE-seek picture: frame 279 overlaid on 66). rVFC is registered
only for fallback views (registering it on every view altered Chrome's
presentation). Measured on real browsers with `verify/play-xb.html` (app's
decoder + this loop on barcode clips, every camera's canvas read back against
its overlay frame at random instants; under the headed-browser lock, no hidden
tabs; % aligned for 5×H.264 60 fps / 5×H.264 150 fps / 8×HEVC 60 fps, the
previous loop → this one, both on the same main):

| | 120 Hz display | 60 Hz display |
|---|---|---|
| Chrome | 100/100/100 → 100/100/100 | 100/87.3/100 → 100/100/100 (judging tolerance) |
| Brave | 100/100/100 → 100/100/100 | 100/100/100 → 100/100/100 |
| Safari | 83.5/1.6/69.0 → 100/96.2/100 | 76.5/1.3/24.5 → 100/94.8/100 |
| Firefox | 48.7/49.7/52.2 → 98.1/89.6/91.9 | 12.2/1.7/47.3 → 77.3/28.5/80.4 |

Firefox's camera 0 also shows every frame now (60 fps video: 34 → 60
distinct frames/s at 120 Hz, 50 → 60 at 60 Hz). What remains is
what the browsers expose: at 150 fps Safari shows ~26 of 150 frames/s and
occasionally hands `drawImage` a buffer 1–2 older than its callback's; Firefox
gives no certainty within a refresh at 60 Hz, and at 150 fps cannot keep its
frames on its own clock. `self._refreshFallback` exposes the fallback state
(each Firefox view's `clock`). WHICH frame each view shows is chosen
by an exported, pure **`PlaybackSchedule`**, with
**`pickScheduledFrame(target, shown, pending, cap)`** choosing per view between
the frame on screen, ONE capture held from an earlier refresh, and this
refresh's capture (hold while the target hasn't passed the shown frame; else
the newest frame not past the target, else the oldest one past it — never run
ahead). The schedule only acts when a video frame spans MORE than one refresh
(frames/refresh < 0.9, e.g. 60 fps on 120 Hz): it is a frame clock locked to
the rAF timestamps — anchored on the primary's captures only after the refresh
interval is measured, phased so frame boundaries sit half a lattice spacing
from refresh instants, run one phase-preserving unit BEHIND the captures so
the needed frame is normally already captured, drift-corrected only for
genuine drift (> 0.8 frame, in phase-preserving units), re-anchored on
stall/seek/rate change. When the video is as fast as the display or faster it
returns the primary's capture unchanged (newest frame every refresh — a
schedule there only adds holds). All views aim at the same frame, so cameras
stay in step — and a SECONDARY view's target is additionally clamped to the
frame the primary actually reached this refresh (`min(target, shown[0])`).
Without that clamp the schedule, being a free-running clock, reaches a frame
only some views have captured: those paint it while the primary holds, so two
cameras sit one frame apart and the overlay — drawn at the primary's index —
disagrees with the secondary's canvas. That only happens when the schedule is
ACTIVE (frames/refresh < 0.9), i.e. on a >60 Hz display, which is why a
headless run (software rAF ≈ 60 Hz, scheduling off) cannot see it. Measured on 60 fps video at 120 Hz: ~30% of frames held for 3 or
1 refreshes instead of 2 without it; the cadence is unit-tested
(tests/test-playback-frame-sync.js) against captures modelled on the real ones
(½-refresh stale, σ ≈ 0.1 frame jitter, measured from the benchmark's raw
timelines), including exact rate ratios at every starting phase. The previous
loop — everything redrawn from the PRIMARY view's `requestVideoFrameCallback`
`mediaTime` — is opt-in via `window.LUCID_PLAYBACK_LOOP='rvfc'`. Why: with
150 fps video (5-camera Mimica project) Chrome presented that one off-page
primary `<video>` at a rate that varied at random per playback start (~60–120
Hz on a 120 Hz display), capping every canvas, overlay and the 3D view at it,
while the other cameras' overlays sat up to 3–4 frames off their video. Covered
by the "default refresh loop" block in `tests/test-playback-frame-sync.js`.

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
- `STEP_CURSOR_IDLE_MS` (3000) — idle time before a paused-stepping stream closes.
- `STEP_BACK_CHUNK` (24) — frames decoded and cached per backward step.
- `STEP_BACK_WARM_MS` (250) — pause after landing on a frame before warming the chunk behind it.
- `OnDemandVideoDecoder` — class. Selected methods: `init(source)`,
  `getFrame(frameIndex)` (mediabunny: via `_mbGetFrame`, the open stepping
  stream), `releaseStepCursor()`, `_initMediabunny(source)` /
  `_mediabunnyEnabled()` (default-on frame-accurate backend, issue #115),
  `_mbCannotDecode(backend)` (null, or `{reason: 'codec', codec, codecString}`
  when WebCodecs cannot decode the track — the backend is then dropped and
  that object kept as `_mbUnavailable`), `html5SeekTime(i)` (`(i + 0.5)/fps`,
  the `<video>` stepping seek target),
  `decodeRange(start, end)`, `playNative`, `pauseNative`, `seekNative`,
  `switchSource`, `close`, `drawCurrentFrame`, `_awaitPlayable` (init and
  switchSource await the element's load through it: when the browser refuses
  the file it throws `video-codec-diagnosis.js`'s explanation instead of a
  bare "Video error code 4", with `err.codecDiagnosis` and `err.cause`),
  `captureCurrentFrame` (returns
  `{frame: VideoFrame, index}` for the per-refresh playback loop — index from
  the captured frame's own timestamp; caller closes the frame; null when
  WebCodecs/data is unavailable).
  `_initMp4box` reads the container's sample table for the real frame count
  and fps WITHOUT a WebCodecs support check (it never decodes with WebCodecs):
  an early return when WebCodecs couldn't decode the codec (Firefox + HEVC)
  left `_fps` at the 30 fps placeholder, halving every frame index.
- `PlaybackSchedule` — class; `update(now, capturedIdx, framesPerMs)` → the
  frame index that should be on screen this refresh; `reset()`.
- `pickScheduledFrame(target, shownIdx, pendingIdx, capIdx)` →
  `'shown'|'pending'|'cap'|null` (hold until the target passes the shown
  frame; then the newest candidate not past it, else the oldest past it).
- `CoalescedFrameClock` — class (pure); which frame Firefox's
  `drawImage(<video>)` paints, from its coalesced rVFC callbacks.
  `observe(now, index, expectedDisplayTime, framesPerMs, fallbackPeriodMs)`
  per callback; `frameAt(t, slackMs)` → `{index, certain, step}` (index = the
  midpoint guess when not certain; step = frames per refresh) or null while
  unknown; `reset()`. Ignores a callback that only re-reports a frame (the
  paused start frame, a stall), forgets the clock when the frame goes back,
  and adopts a jump AHEAD only once the next callback confirms it (Firefox
  sometimes reports a frame ~10 ahead that is never painted). Unit-tested on
  simulated Firefox callbacks in `tests/test-playback-frame-sync.js`.
- `EmbeddedVideoDecoder` — class for SLP-embedded frames. `getFrame`,
  `hasFrame`, `close`.
- `VideoController` — class. Selected methods: `seekToFrame`,
  `scrubToFrame`, `togglePlayback`, `startPlayback`, `stopPlayback`,
  `pausePlayback` (user-pause: stop + frame-accurate re-decode — mediabunny,
  or the mid-frame `<video>` seek where WebCodecs cannot decode — of the frame
  playback stopped on, so every camera rests exactly on-frame with the pose
  overlay; the play button and spacebar call this, internal stops call
  `stopPlayback`. It used to step one frame FORWARD (issue #115), which the
  per-refresh loop made a visible jump on every pause; re-decoding the current
  frame repaints an identical picture in Chrome/Brave and still lines up the
  Safari/Firefox fallback loop and any camera that stopped a frame out of step
  with camera 0. Measured in all four browsers at 60/120 Hz with barcode
  clips: +0 ends aligned in 100% of camera-pauses — Firefox HEVC included
  since its stepping moved to mid-frame seeks, see `_html5Moved` above),
  `_startBufferedPlayback` / `_bufferedPlaybackEnabled` (buffered
  video-led mediabunny playback, issue #115),
  `setupSeekbar`, `setupKeyboardHandlers`, `initZoom`, `applyZoom`,
  `zoomVideo`, `resetZoom`, `zoomToRect`, `zoomAllVideos`,
  `resetAllZoom`, `setupZoomHandlers`.

**`setupZoomHandlers`'s wheel-to-zoom stands down while Alt is held.** Alt
turns the wheel into the instance-rotation control (`ui/interaction.js`
`onWheel`, issue #198), whose listener is on the OVERLAY CANVAS — which does
not fill the `.video-cell` this handler is bound to. A video narrower or
shorter than its pane leaves letterbox margin with no canvas under the cursor,
so `onWheel` never runs there and only this `e.altKey` early return keeps an
Option+scroll that strayed into the margin from zooming the view out from under
a rotation in progress. Removing the line alone turns the margin check in
`tests/e2e/alt-wheel-rotate-instance.mjs` red.

**Imports from project modules.** `ui/keyboard-target.js` — the
`shouldIgnoreShortcut` guard its `setupKeyboardHandlers` keydown listener
applies (issue #163); that module imports nothing itself — and
`loading/video-codec-diagnosis.js` (`diagnoseUnplayableVideo`, for
`_awaitPlayable`). `mediabunny` (`EncodedPacketSink`) is imported lazily by
`_keyTimestamp`. Otherwise none (uses the global `MP4Box` from script tag, and
`window.SleapIO.MediaBunnyVideoBackend`).

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
SESSION-SCOPED settings — and for the other per-session panel state that belongs
in the project file: the ID Switches tab's review checklist (`idSwitchReview`,
`ui/id-switch-review.js`). One module owns the key list so a writer and a reader
cannot drift: adding a setting means touching this file and nothing else.

**What it covers, and what it deliberately does not.** The Visibility panel
holds two kinds of state:
- **Session-scoped** — per-camera video brightness / contrast / rotation and the
  timeline's hidden camera / track / identity sets. These describe *this
  project's* videos and entities, so they belong in the project file. That is
  everything this module handles.
- **Global appearance preferences** — the User / Predictions / Reprojections /
  Planes / Display Legend / 3D Viewer sliders, styles and toggles. Those are
  browser-local display taste, shared across every session, and stay in
  `localStorage.visibilitySettings` (see `ui/ui-wiring.js`). They are **not**
  written here on purpose: baking them into the `.slp` would make opening a
  colleague's project silently reassign your node sizes and 3D widgets.

**Key exports.**
- `VISIBILITY_METADATA_KEYS` — every key this module may write
  (`videoBrightness`, `videoContrast`, `videoRotation`, `hiddenCameras`,
  `hiddenTracks`, `hiddenIdentities`, `idSwitchReview`). Exported so tests can assert a default
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
`../ui/timeline-visibility.js`, `../ui/id-switch-review.js` — all dependency-free leaves, so this module
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
`tests/e2e/visibility-settings-roundtrip.mjs` (real app, both writers; includes
the ID Switches checklist).

---

### import-export/mesh-export.js

**Purpose.** A 3D mesh object as a file another program can open: **binary
STL** for CAD and **binary glTF (.glb)** for Blender. Both take the same
`MeshObjectGeometry` that `pose/mesh-object-geometry.js` derives, so neither
format re-derives anything and a shape that is wrong in one is wrong in both
rather than wrong in different ways. DOM-free and pure — geometry in, bytes
out; `ui/mesh-objects.js` owns the buttons and the download.

**The one sanctioned axis conversion.** The project rule is that LUCID's world
is Z-up, Blender's is too, and no axis conversion belongs in the plane/mesh
pipeline. That rule is about the PIPELINE, and it does not survive contact with
glTF, whose spec FIXES the up axis at +Y (glTF 2.0 3.5):

| format | axes | why |
|---|---|---|
| STL | verbatim Z-up | the format defines no up axis; CAD treats Z as up |
| GLB | `(x, y, z)` -> `(x, z, -y)` | the spec mandates +Y up; Blender's importer applies the inverse, landing it back Z-up |

Write Z-up into a .glb instead and the file is off-spec: Blender still rotates
it, so the cage arrives lying on its side, and three.js / Babylon / Sketchfab /
QuickLook all show it tipped over. The conversion is a -90 degree rotation
about X, determinant +1 — a rotation, **not** a mirror — so triangle winding
survives and **no winding flip accompanies it**. Adding one later would
silently invert every normal.

**Key exports.**
- `meshObjectToSTL(geometry, {name})` -> `Uint8Array | null`. Binary, not
  ASCII: ~5x smaller and exact to the last float32 bit. The 80-byte header
  deliberately does not begin with `solid`, which is what makes lenient parsers
  guess ASCII and read garbage. STL repeats every corner per triangle, so the
  node-level welding is invisible in the file — by the format's design.
- `meshObjectToGLB(geometry, {name, color})` -> `Uint8Array | null`. One
  self-contained file (JSON chunk + BIN chunk, spec padding: spaces for JSON,
  zeros for BIN). Vertices stay **welded** and indexed. **No NORMAL attribute,
  deliberately** — glTF then mandates flat shading, which is right for a
  faceted cage; supplying normals would mean either splitting every shared
  vertex (undoing the welding) or smoothing across hard edges that are real.
  The colour is converted sRGB -> **linear**, because `baseColorFactor` is
  linear and passing the picker's hex through makes every export paler than the
  swatch.
- `isExportable(geometry)` — what the buttons gate on.
- `meshFilenameStem(name)` — object names are free text, and a slash in a
  download name is a path the browser will not write.

**Both return `null` rather than an empty file.** An empty export opens, shows
nothing, and reads as "my annotation is broken" rather than "I exported an
object with no triangulated faces yet".

**Precision.** Positions are float32 in both formats — not a choice, it is what
the formats define. LUCID's float64 millimetres keep ~1e-4 mm at ~1e3 mm, so a
re-imported mesh is not bit-identical to the project's numbers. The project
file stays the source of truth.

**Imports from project modules.** None. **Imported by.** `ui/mesh-objects.js`.

**Tests.** `tests/test-mesh-export.mjs` (the byte layouts, with a negative
control on each axis claim) and `tests/e2e/mesh-object-export.mjs` (the buttons
and the downloaded bytes). The axis behaviour was additionally confirmed
against **real Blender** in `--background` mode: both files put the tracked
corner at (0, 0, 300).

---

### import-export/plane-metadata.js

**Purpose.** The `metadata.lucid` ↔ plane-state mapping, and the reason plane
edits now mark the project dirty. The Define Planes pipeline (nodes, planes,
per-view 2D, triangulation, plane fit, origin frame) is project state — it
describes *this* project's cage, floor and reference geometry — but until this
module none of it reached the project file, which is why `ui/plane-definition.js`
deliberately did **not** call `markDirty()`: flagging a project dirty for state a
save would silently drop is worse than losing it. Same shape and the same three
invariants as `import-export/visibility-metadata.js`; one module owns the key
list so a writer and a reader cannot drift.

**The scope split, and why one payload is written N times.** `metadata.lucid` is
per SESSION, but the plane model is not:
- The **node pool, the planes, the 3D Mesh Objects and the origin frame are
  PROJECT-scoped** — a node has one 3D position whatever session you are looking
  at, and "these planes are the cage" is a statement about the project's geometry
  rather than about any one recording. They are written
  IDENTICALLY into every session's dict, so opening any one session of a
  multi-session project restores the same geometry, and read back by whichever
  session is ingested first (the rest hold the same bytes). Duplication is the
  price of a per-session container; the payload is a few dozen nodes, not a
  frame table.
- The **per-view 2D is SESSION-scoped**, because a view belongs to a session. It
  lives on `Session.planePlacements`, exactly where `planeModel()` picks it up.

**Key exports.**
- `PLANE_METADATA_KEYS` — `planeNodes`, `planes`, `meshObjects`,
  `planePlacements`, `planeOrigin`. Exported so the slim-metadata / golden-digest
  guards can assert a project that never opened the feature carries none of them.
- `writePlaneMetadata(lucid, session)` — mutate a `metadata.lucid` dict in place;
  returns the same dict. Reads the pool / planes off the module singleton and the
  2D off `session.planePlacements`, so saving a BACKGROUND session writes its own
  placements rather than whichever map the model happens to have attached.
- `readPlaneMetadata(session, lucid)` — placements land on `session`; the
  project-scoped half lands on the shared model **only when it is still empty**.
  That guard is what makes ingesting N sessions idempotent: the first session
  carrying plane state restores it, the rest are skipped rather than appended
  (which would double every node).
- `resetPlaneState()` — empty the model (pool, planes AND mesh objects, all three
  via one `restorePlaneProject(model, null)`), drop the applied origin and the
  plane selection. **Every load path must call it**, because the corollary of the
  empty-model guard is that skipping it does not merge the two projects — it
  keeps the OLD one and silently discards the NEW one's planes. Called by
  `newProject`, the JSON load, the eager `.slp` import, the lazy reopen and the
  demo-session load.

**What is deliberately NOT written.** The plane panel's node size, edge width and
3D corner size are browser-local display taste — the same category as the
Visibility panel's global appearance preferences, and kept out of the `.slp` for
the same reason. So are the editor's transient selections. The one thing restored
beyond the data is the plane SELECTION being re-pointed at a plane that still
exists, since a selection naming a deleted plane renders an empty editor.

**Imports from project modules.** `../pose/plane-serialization.js` (all the
actual mapping); `../ui/plane-definition.js` — `planeState`;
`../ui/origin-definition.js` — `originState`; `../ui/app-state.js` — `state`.
The two `ui/` imports are circular by design and safe for the same reason the
rest of this feature's cycles are: every use is inside a function body, so the
bindings resolve at call time.

**Imported by.** The four writers — `import-export/file-io.js`
(`buildSlpLabelsAllViews`), `import-export/slp-streaming-write.js`
(`buildSessionRefGraph`), and `import-export/save-load.js` (`saveProject`, both
the v2 and v3 project-JSON shapes) — and the three readers —
`import-export/slp-import.js` (`handleLoadSlpFile`), `loading/session-loader.js`
(`handleLoadProjectSlpLazy`), and `import-export/save-load.js`
(`_restoreProjectV2`). Plus `pose/initialization.js` for `resetPlaneState` on the
demo-session load.

**Tests.** `tests/e2e/plane-persistence-roundtrip.mjs` (real app, both `.slp`
writers, the dirty-flag half, the session-scope split, the untouched-project
control and the replace-not-merge control) over
`tests/test-plane-serialization.mjs` (the mapping itself).

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
  null. Accepts SLEAP's **list-wrapped** GUI export (`[{…}]`) and the `nx_graph`
  nesting as well as a bare object.

**Reading SLEAP's own exports (issue #205).** The jsonpickle branch lives in the
module-private `parseJsonPickleSkeleton`, which has to reconstruct jsonpickle's
`py/id` memo table — and the two writers in the wild disagree about it:

- SLEAP / `sleap_io` re-emit a node's **full `py/object` at every appearance** in
  `links` and use `py/id` only in `nodes`, so a node takes ONE memo slot however
  many edges it touches.
- `buildSkeletonJSON` emits the full object once, then `py/id` back-references.

Deduplicating by name satisfies both. Counting every `py/object` (the pre-#205
behaviour) was right only for LUCID's own files: on a SLEAP export with a hub
node the table gained a bogus slot per repeat, and since a SLEAP export's `nodes`
array is *nothing but* `py/id` references — no names at all — everything past the
first repeat resolved to the wrong node, yielding a silently duplicated/missing/
placeholder skeleton rather than an error.

Node **order** has its own wrinkle: SLEAP's encoder numbers node `py/id`s without
counting the EdgeType's slot while its decoder counts it, so the `nodes` array is
off by one from the table it nominally indexes. `sleap_io` gives up and returns
edge-traversal order; we re-read the array in the node-only space, recovering the
order SLEAP actually displays — so the JSON path agrees with the `.slp` path.
Both interpretations must yield a complete permutation to be accepted, else we
fall back to traversal order as `sleap_io` does. Edge types are resolved against
the shared table first and SLEAP's **separate** edge-type id space (1 = regular,
2 = symmetry) only on a miss; symmetries are dropped, their nodes kept.

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
- SLP parse (raw worker): `parseSlpH5(file, onProgress, opts)` — spawns
  `slp-import-worker.js`. Kept for SLEAP analysis `.h5`, as the
  `parseSlpViaSleapIO` fallback, and for the per-camera session-folder load,
  which passes `{ columnar: true }` to receive the poses as flat transferred
  typed arrays (`data.columnar`) instead of nested `data.frames`.
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
- Misc: `downloadJSON`, `downloadBytes` (the binary sibling, for the STL/GLB
  mesh exports; the Blob is handed the VIEW, never `bytes.buffer`, which on a
  subarray would write the neighbouring bytes too), `instancePointsMatch`,
  `instanceMatchesPoints`
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
`ui/export-modals.js`, `ui/ui-wiring.js`, `ui/origin-definition.js`
(`exportCalibrationTOML` + `downloadTOML`) and
`ui/origin-rebase.js` (the same two, for the in-place `calibration.toml`).

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
  A per-camera session reopens through parallel `open()`s in `sourceFiles`
  order (= the ORIGINAL load's resolution order); neither order matters, since
  `SioLazyLoader._unifyTracks` re-indexes every store into the union of the
  cameras' track names in camera-NAME order — so pass 2 re-derives the track
  columns the original load had.
  **A store edited in memory is written AS EDITED.** Propagate IDs → Tracks
  (and every other `remapTracksFromIdentity` caller) and Custom Instance
  Delete (`deleteInstanceRows`) change the live store's columns, which are not
  in the source files — but pass 1 builds the header tracks, each camera's
  `trackBase` and every group's `(frame, instance offset)` refs from that live
  store. Pass 2 used to append the files' columns under it: every propagated
  instance came out on the wrong track name, deleted instances came back, and a
  group member sitting after a deleted row in its camera-frame resolved to the
  deleted instance's points. Now `commitSessionForMultiSessionSave` keeps the
  loader's `framesData` + `instancesData` per camera when
  `SioLazyLoader._storeEditedInMemory` is set (`keepEditedStoreColumns`, stored
  as `editedColumns` on `handle.pending`), and `finalizeMultiSessionSave` puts
  them back over the re-opened stores before `streamSessionIntoWriter`
  (`restoreEditedStoreColumns`). Those two are all either edit touches: a
  delete keeps every survivor's `point_id_start/end`, pointing into the
  unchanged points table — so `pointsData`/`predPointsData`, by far the
  largest part of a store, are still evicted and re-read, and an UNEDITED
  session keeps nothing at all. `restoreEditedStoreColumns` throws if the
  re-opened file no longer fits the kept columns (another frame-row count, or a
  points table shorter than the largest kept `point_id_end`): the file changed
  on disk after loading, and writing edited instances against its rows would be
  silent corruption. The single-session save streams from the live loader and
  never had this. Covered by `tests/e2e/multi-session-save-store-edits.mjs`
  (confirmed to fail pre-fix: wrong track names, resurrected rows, the group on
  the deleted instance, no refusal).

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
- Status / overlay: `showLoading(msg)`, `hideLoading` (re-exported from
  `ui/loading-overlay.js`, which owns the overlay; kept here because ~10 modules
  import them from this one), `setStatus(text, type)`.

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
  `../ui/browser-hints.js` (`fileSystemAccessHint` — `saveProjectSlp`, the
  download fallback when there is no save-file picker, says why and how to
  enable it in Brave), `../loading/video.js`, `../demo-data.js`, `./file-io.js`,
  `../ui/app-state.js`, `../loading/session-loader.js`,
  `../loading/sio-lazy-loader.js` (`SioLazyLoader`, for
  `reopenSessionLazyLoader`), `./slp-streaming-write.js`,
  `../ui/rendering.js`, `../ui/info-panel.js`,
  `../ui/frame-readout.js` (`clearReadout`, New Project),
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
`ui/sessions-panes.js`, `ui/ui-wiring.js`, `ui/view-align-modal.js`.

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

**Lazy reopen's lightweight members share ONE placeholder.**
`reconstructInstanceGroupsFromSessionLazy` builds each group member WITHOUT its
2D (it is hydrated on scrub by `_rawInstIndex`, `finalizeLazyFrameGroup`); the
stand-in is now the shared `lazyPlaceholderXY(numNodes)` (`pose/pose-data.js`),
adopted by reference, instead of a private NaN-filled `Float64Array` per member
— ~335 B and one ArrayBuffer each, 2.66M of them on the real cage5 project. The
same placeholder is what `pose/lazy-residency.js` releases members back to, so a
reopened project and a freshly tracked one look alike off-screen.
Every restored group's 3D goes into the slab pool (`pooledPoints3d`,
`pose/pose-data.js`): the reader hands one compacted `Float64Array` per group
(#189), i.e. one ArrayBuffer each; the copy is ~360 B of backing store per
group, outside V8's pointer cage, and the reader's array is released with its
typed group.

**Imports from project modules.**
- `../pose/pose-data.js` (incl. `lazyPlaceholderXY`), `../pose/triangulation.js`, `./file-io.js`,
  `./slp-merge.js`, `../loading/video.js`, `../ui/app-state.js`,
  `../loading/session-loader.js`, `./save-load.js`,
  `../ui/rendering.js`, `../ui/info-panel.js`,
  `../ui/calibration-notice.js` (`noteSessionCalibrationDivergence`, behind the
  multi-session skeleton prompt — a `.slp` carries one calibration per session,
  so merging two separately-calibrated recordings lands here too),
  `../pose/initialization.js`, `../ui/ui-wiring.js`,
  `../ui/frame-readout.js` (`refreshReadoutTotals`, when a video-less import
  sets the frame count), `../ui/sessions-panes.js`, `./visibility-metadata.js`
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

---

### server.py

**Purpose.** Development server (`SimpleHTTPRequestHandler`). Serves the static
tree, keeps a legacy `POST /convert-slp` endpoint alive when `h5py` is present,
and implements **offline mode**.

**CLI.** `python3 server.py [port] [--offline]`; `LUCID_OFFLINE=1` also enables
offline. Prints which mode it started in.

**Offline mode.** Reads `offline-deps.json` via `scripts/offline_deps.py` and
rewrites the mapped CDN URLs in served `.html` / `.js` / `.mjs` bodies to
depth-relative `lib/` paths (`./lib/…` at root, `../lib/…` from `tests/`). Files
on disk are never modified, so the working tree keeps its CDN URLs. Refuses to
start when a declared package is missing rather than serving a page that half
works. `.js` coverage is required, not optional: two of the six CDN references
are ESM imports inside `ui/sessions-panes.js` and `ui/overlay-export-modal.js`.

**Imports from project modules.** `scripts/offline_deps.py` —
`load_manifest`, `package_status`, `replacement_map`, `rewrite_text`.

**User-facing features.** Local development; offline development.

---

### scripts/offline_deps.py

**Purpose.** Fetch, verify and vendor the four CDN dependencies declared in
`offline-deps.json` into gitignored `lib/` directories, and build a
pre-rewritten offline bundle. Standard library only — no Node, curl, tar or
Git Bash, so it behaves identically on Linux, macOS and Windows.

**CLI.** `install` (idempotent; `--force` re-fetches) · `check`
(`--strict` also fails on unmapped CDN URLs) · `bundle` · `clean`.
Honors `LUCID_NPM_REGISTRY`.

**Key functions.** `load_manifest()`, `replacement_map()`, `rewrite_text()`
(shared with `server.py`), `package_status()`, `run_asserts()` (behavioral
checks pinning the API each package must still expose), `check_pins()`
(re-derives the dockview version pin from source rather than trusting prose),
`find_unmapped_cdn_urls()`.

**Imported by.** `server.py`; `tests/e2e/offline-server.mjs` shells out to it.

**User-facing features.** Offline install and the distributable bundle.
