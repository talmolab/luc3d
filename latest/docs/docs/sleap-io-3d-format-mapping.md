# Lucid ↔ sleap-io 3D Format Mapping

This document maps between Lucid's `.mvgui.json` project format and sleap-io's Python data model for multi-view 3D pose annotation. It covers the current state of both, identifies gaps, and proposes extensions to sleap-io for full 3D support (ref: [sleap-io#204](https://github.com/talmolab/sleap-io/issues/204), [sleap-io#206](https://github.com/talmolab/sleap-io/issues/206)).

---

## Top-Level Container

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `version` | `int` (2 or 3) | — | — | Lucid-specific versioning |
| *(root object)* | — | `Labels` | `@attrs.define` | Top-level container |
| `sessions[]` (v3) | array | `Labels.sessions[]` | `list[RecordingSession]` | Multi-session support |

### Lucid JSON (v2)
```json
{
  "version": 2,
  "skeleton": { ... },
  "cameras": [ ... ],
  "tracks": [ ... ],
  "identities": [ ... ],
  "trustTracks": true,
  "trackIdentityMap": [ ... ],
  "frameIdentityMap": [ ... ],
  "videoManifest": [ ... ],
  "frames": { ... }
}
```

### sleap-io Python
```python
Labels(
    skeletons=[skeleton],
    tracks=[track_0, track_1],
    sessions=[RecordingSession(
        camera_group=CameraGroup(cameras=[cam_a, cam_b]),
        # frame_groups indexed by frame_idx
    )],
    labeled_frames=[...],  # per-camera 2D frames
)
```

---

## Skeleton

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `skeleton.name` | `string` | `Skeleton.name` | `str \| None` | Direct match |
| `skeleton.nodes[]` | `string[]` | `Skeleton.nodes[]` | `list[Node]` | Lucid stores names; sleap-io stores `Node` objects with `.name` |
| `skeleton.edges[][]` | `[int, int][]` | `Skeleton.edges[]` | `list[Edge]` | Lucid stores index pairs; sleap-io stores `Edge(source=Node, destination=Node)` |
| — | — | `Skeleton.symmetries[]` | `list[Symmetry]` | **Not in Lucid.** Left/right symmetry pairs. |

### Conversion
```
Lucid → sleap-io:
  nodes = [Node(name=n) for n in skeleton.nodes]
  edges = [Edge(source=nodes[e[0]], destination=nodes[e[1]]) for e in skeleton.edges]

sleap-io → Lucid:
  skeleton.nodes = [n.name for n in skeleton.nodes]
  skeleton.edges = [[skeleton.index(e.source), skeleton.index(e.destination)] for e in skeleton.edges]
```

---

## Camera

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `cameras[].name` | `string` | `Camera.name` | `str` | Direct match |
| `cameras[].matrix` | `number[3][3]` | `Camera.matrix` | `np.ndarray (3×3)` | Intrinsic matrix K |
| `cameras[].dist` | `number[5]` | `Camera.dist` | `np.ndarray (5,)` | `[k1, k2, p1, p2, k3]` |
| `cameras[].rvec` | `number[3]` | `Camera._rvec` | `np.ndarray (3,)` | Rodrigues rotation vector |
| `cameras[].tvec` | `number[3]` | `Camera._tvec` | `np.ndarray (3,)` | Translation vector |
| `cameras[].size` | `[int, int]` | `Camera.size` | `tuple[int, int]` | `[width, height]` |
| *(cameras array)* | — | `CameraGroup.cameras` | `list[Camera]` | Group wrapper |
| — | — | `Camera.metadata` | `dict` | **Not in Lucid.** Generic metadata bucket. |

### Conversion
Direct field-to-field. Arrays ↔ numpy.

---

## Tracks & Identities

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `tracks[]` | `string[]` | `Labels.tracks[]` | `list[Track]` | Lucid stores names; sleap-io stores `Track(name=...)` |
| `identities[]` | `{id, name, color}[]` | — | — | **Not in sleap-io.** See [#206](https://github.com/talmolab/sleap-io/issues/206). |
| `trustTracks` | `boolean` | — | — | **Not in sleap-io.** Whether to trust track labels from predictions. |
| `trackIdentityMap` | `[string, int][]` | — | — | **Not in sleap-io.** Global mapping of `"camera:trackIdx"` → `identityId`. |
| `frameIdentityMap` | `[string, int][]` | — | — | **Not in sleap-io.** Per-frame overrides `"frame:camera:trackIdx"` → `identityId`. |

### Proposed sleap-io Extension (issue #206)
```python
@attrs.define
class Identity:
    """Ground truth animal identity, persistent across sessions."""
    name: str
    id: int
    color: str | None = None

# On Labels:
Labels.identities: list[Identity]

# On Instance or Track:
Track.identity: Identity | None = None  # link track → animal
```

### Conversion
```
Lucid → sleap-io:
  tracks = [Track(name=t) for t in data.tracks]
  # identities: store in Labels.identities (proposed)
  # trackIdentityMap: store as Track.identity linkages

sleap-io → Lucid:
  data.tracks = [t.name for t in labels.tracks]
  # identities: extract from Labels.identities (proposed)
```

---

## Recording Session

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `sessions[].name` (v3) | `string` | `RecordingSession.metadata["name"]` | `dict` | No dedicated field in sleap-io |
| `videoManifest[]` | `{filename, assignedCamera}[]` | `RecordingSession._video_by_camera` | `dict[Camera, Video]` | Lucid stores manifest; sleap-io stores bidirectional camera↔video maps |

---

## Frame Data

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `frames` | `{frameIdx: FrameData}` | `RecordingSession._frame_group_by_frame_idx` | `dict[int, FrameGroup]` | Keyed by frame index |
| `frames[idx].instanceGroups[]` | array | `FrameGroup._instance_groups` | `list[InstanceGroup]` | Cross-view correspondences |
| `frames[idx].unlinkedInstances[]` | array | `FrameGroup._labeled_frame_by_camera` | `dict[Camera, LabeledFrame]` | Unlinked 2D instances live in per-camera LabeledFrames |

---

## InstanceGroup (the 3D correspondence)

This is the key structure for multi-view 3D. It links 2D instances across cameras and holds triangulated 3D data.

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `instanceGroup.id` | `number` | — | — | Unique identifier. sleap-io uses object identity. |
| `instanceGroup.trackIdx` | `int` | *(via Instance.track)* | `Track` | Lucid indexes into `tracks[]`; sleap-io uses Track object refs |
| `instanceGroup.identityId` | `int` | — | — | **Not in sleap-io.** Maps to proposed `Identity`. |
| `instanceGroup.instances` | `{camName: Instance}` | `InstanceGroup._instance_by_camera` | `dict[Camera, Instance]` | Lucid keys by camera name; sleap-io keys by Camera object |
| `instanceGroup.points3d` | `[[x,y,z]\|null][]` | `InstanceGroup._points` | `np.ndarray \| None` | Triangulated 3D keypoints |
| `instanceGroup.reprojections` | `{camName: [[x,y]\|null][]}` | — | — | **Not in sleap-io.** Reprojected 2D from 3D back to each camera. |
| `instanceGroup.observedPoints` | `{camName: [[x,y]\|null][]}` | — | — | **Not in sleap-io.** Original observed 2D at time of triangulation. |
| `instanceGroup.usedCameras` | `string[]` | — | — | **Not in sleap-io.** Which cameras contributed to triangulation. |
| — | — | `InstanceGroup._score` | `float \| None` | Group-level confidence. Lucid doesn't have a group score. |
| — | — | `InstanceGroup.metadata` | `dict` | Generic metadata. Could store reprojections, usedCameras here. |

### Proposed sleap-io Extension (issue #204)
```python
@attrs.define(eq=False)
class InstanceGroup:
    _instance_by_camera: dict[Camera, Instance] = attrs.field(factory=dict)
    _score: float | None = None
    _points: np.ndarray | None = None  # (N, 3) triangulated 3D points

    # --- Proposed additions ---
    _reprojections: dict[Camera, np.ndarray] | None = None  # per-camera (N, 2) reprojected 2D
    _observed_points: dict[Camera, np.ndarray] | None = None  # original 2D at triangulation time
    _used_cameras: set[Camera] | None = None  # cameras that contributed to triangulation
    track: Track | None = None  # track assignment (currently implicit via Instance.track)
    identity: Identity | None = None  # identity assignment
    metadata: dict = attrs.field(factory=dict)
```

### Conversion
```
Lucid → sleap-io:
  ig = InstanceGroup()
  for camName, instData in group.instances:
      camera = camera_by_name[camName]
      ig._instance_by_camera[camera] = to_sleap_instance(instData)
  ig._points = np.array(group.points3d)  # None entries → NaN rows
  ig._reprojections = {camera_by_name[k]: np.array(v) for k, v in group.reprojections.items()}
  ig._observed_points = {camera_by_name[k]: np.array(v) for k, v in group.observedPoints.items()}
  ig._used_cameras = {camera_by_name[k] for k in group.usedCameras}

sleap-io → Lucid:
  group.instances = {cam.name: from_sleap_instance(inst) for cam, inst in ig._instance_by_camera.items()}
  group.points3d = ig._points.tolist()  # NaN rows → null
  group.reprojections = {cam.name: pts.tolist() for cam, pts in ig._reprojections.items()}
  group.observedPoints = {cam.name: pts.tolist() for cam, pts in ig._observed_points.items()}
  group.usedCameras = [cam.name for cam in ig._used_cameras]
```

---

## Instance (per-camera 2D)

| Lucid JSON | Type | sleap-io | Type | Notes |
|---|---|---|---|---|
| `instance.points` | `[[x,y]\|null][]` | `Instance.points` | `PointsArray` | See point-level mapping below |
| `instance.trackIdx` | `int` | `Instance.track` | `Track \| None` | Lucid indexes; sleap-io uses object ref |
| `instance.type` | `"user"\|"predicted"` | class type | `Instance` vs `PredictedInstance` | Lucid uses string; sleap-io uses subclass |
| `instance.score` | `float` | `PredictedInstance.score` | `float` | Only on predicted instances |
| `instance.modified` | `boolean` | — | — | **Not in sleap-io.** Edit tracking flag. |
| `instance.occluded` | `boolean[]` | `PointsArray["visible"]` | per-point `bool` | **Inverted.** `occluded[i]=true` ↔ `visible[i]=false` |
| `instance.nulledNodes` | `int[]` | — | — | **Not in sleap-io.** Nodes excluded from triangulation. See proposal below. |
| — | — | `Instance.skeleton` | `Skeleton` | sleap-io requires skeleton ref on each instance |
| — | — | `Instance.from_predicted` | `PredictedInstance` | Link user instance to prediction it was derived from |
| — | — | `Instance.tracking_score` | `float \| None` | Tracker confidence |

### Point-Level Mapping

| Lucid | sleap-io PointsArray | Notes |
|---|---|---|
| `points[i] = [x, y]` | `points[i]["xy"] = [x, y]`, `visible=True` | Normal visible point |
| `points[i] = null` | `points[i]["xy"] = [NaN, NaN]`, `visible=False` | Missing / not detected |
| `occluded[i] = true` | `points[i]["visible"] = False` | Has coords but excluded from display |
| `nulledNodes.has(i)` | — | **Not in sleap-io.** Has coords but excluded from triangulation |

### Proposed sleap-io Extension for nulledNodes
```python
# Option A: Add a "triangulation_excluded" field to PointsArray dtype
# PointsArray dtype: xy (float64, 2), visible (bool), complete (bool),
#                    name (object), excluded (bool)  ← NEW

# Option B: Store on InstanceGroup (more natural for 3D workflow)
class InstanceGroup:
    _excluded_nodes: dict[Camera, set[int]] | None = None
    # Maps camera → set of node indices excluded from triangulation
```

### Conversion
```
Lucid → sleap-io:
  points = PointsArray(n_nodes)
  for i, pt in enumerate(inst.points):
      if pt is not None:
          points[i]["xy"] = pt
          points[i]["visible"] = not (inst.occluded and inst.occluded[i])
      else:
          points[i]["xy"] = [np.nan, np.nan]
          points[i]["visible"] = False

  if inst.type == "predicted":
      sleap_inst = PredictedInstance(points=points, skeleton=skeleton, score=inst.score)
  else:
      sleap_inst = Instance(points=points, skeleton=skeleton)

  sleap_inst.track = tracks[inst.trackIdx]
  # nulledNodes → store on InstanceGroup._excluded_nodes

sleap-io → Lucid:
  inst.points = []
  inst.occluded = []
  for i in range(len(points)):
      if np.isnan(points[i]["xy"]).any():
          inst.points.append(None)
          inst.occluded.append(False)
      else:
          inst.points.append(list(points[i]["xy"]))
          inst.occluded.append(not points[i]["visible"])

  inst.type = "predicted" if isinstance(sleap_inst, PredictedInstance) else "user"
  inst.score = sleap_inst.score if hasattr(sleap_inst, "score") else 1.0
  inst.trackIdx = tracks.index(sleap_inst.track) if sleap_inst.track else 0
  # nulledNodes ← from InstanceGroup._excluded_nodes
```

---

## Complete Hierarchy Comparison

```
sleap-io                              Lucid JSON
────────────────────────────────      ────────────────────────────
Labels                                { version, ... }
├── skeletons[0]                      skeleton: { name, nodes, edges }
├── tracks[]                          tracks: ["track_0", ...]
├── (proposed) identities[]           identities: [{ id, name, color }]
│
├── sessions[0]: RecordingSession     (root or sessions[0])
│   ├── camera_group: CameraGroup     cameras: [{ name, matrix, ... }]
│   │   └── cameras[]
│   ├── video_by_camera               videoManifest: [{ filename, assignedCamera }]
│   │
│   └── frame_groups[idx]:            frames[idx]:
│       FrameGroup
│       ├── instance_groups[]:        instanceGroups[]:
│       │   InstanceGroup
│       │   ├── instance_by_camera    instances: { camName: { points, ... } }
│       │   ├── _points (3D)          points3d: [[x,y,z]|null]
│       │   ├── (proposed)            reprojections: { camName: [[x,y]|null] }
│       │   │   _reprojections
│       │   ├── (proposed)            observedPoints: { camName: [[x,y]|null] }
│       │   │   _observed_points
│       │   ├── (proposed)            usedCameras: ["CamA", "CamB"]
│       │   │   _used_cameras
│       │   ├── track (via Instance)  trackIdx: 0
│       │   └── (proposed) identity   identityId: 0
│       │
│       └── labeled_frames[cam]:      unlinkedInstances[]:
│           LabeledFrame              { cameraName, points, trackIdx, ... }
│           └── instances[]
│
├── trackIdentityMap (proposed)       trackIdentityMap: [["CamA:0", 0], ...]
└── frameIdentityMap (proposed)       frameIdentityMap: [["5:CamA:0", 1], ...]
```

---

## Summary of Gaps

### Fields in Lucid NOT in sleap-io (need proposals)
| Field | Location | Purpose | Proposed sleap-io Home |
|---|---|---|---|
| `identities` | Session | Ground truth animal IDs | `Labels.identities` ([#206](https://github.com/talmolab/sleap-io/issues/206)) |
| `trackIdentityMap` | Session | Track → identity mapping | `Track.identity` |
| `frameIdentityMap` | Session | Per-frame identity overrides | `InstanceGroup.identity` or metadata |
| `trustTracks` | Session | Whether to trust prediction tracks | `RecordingSession.metadata` |
| `reprojections` | InstanceGroup | 2D reprojected from 3D | `InstanceGroup._reprojections` |
| `observedPoints` | InstanceGroup | Original 2D at triangulation time | `InstanceGroup._observed_points` |
| `usedCameras` | InstanceGroup | Cameras used for triangulation | `InstanceGroup._used_cameras` |
| `nulledNodes` | Instance | Nodes excluded from triangulation | `InstanceGroup._excluded_nodes` or PointsArray field |
| `modified` | Instance | Whether user edited this instance | `Instance.metadata["modified"]` |

### Fields in sleap-io NOT in Lucid (can adopt)
| Field | Location | Purpose | Action |
|---|---|---|---|
| `Skeleton.symmetries` | Skeleton | Left/right node pairs | Add to Lucid if needed |
| `Instance.from_predicted` | Instance | Link to source prediction | Add as optional field |
| `Instance.tracking_score` | Instance | Tracker confidence | Already have `score` |
| `Camera.metadata` | Camera | Arbitrary camera metadata | Add if needed |
| `InstanceGroup._score` | InstanceGroup | Group confidence | Could derive from instance scores |
| `PointsArray.complete` | Point | Whether point was user-verified | Could map to `!nulledNodes.has(i)` |
