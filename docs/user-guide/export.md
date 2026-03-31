# Exporting Data

LUC3D supports multiple export formats for 2D annotations, 3D reconstructions, calibration data, and skeleton definitions.

## Export Formats

All export options are available under the **File** menu.

### Labels (JSON)

**File → Export Labels (JSON)**

Exports all 2D annotations as a JSON file with frame-by-frame instance data. This is LUC3D's native format and preserves all annotation metadata.

```json
{
  "skeleton": { "nodes": [...], "edges": [...] },
  "frames": [
    {
      "frame_idx": 0,
      "instances": [
        {
          "points": [[x1, y1], [x2, y2], ...],
          "track": "mouse_1",
          "type": "user",
          "camera": "back"
        }
      ]
    }
  ]
}
```

### 2D SLP (SLEAP Format)

Two options for SLEAP-compatible `.slp` export:

**File → Export 2D SLP (All Views)** — Single `.slp` file with all cameras combined into one video list. Useful for viewing all annotations together.

**File → Export 2D SLP (Per Camera)** — Separate `.slp` file for each camera view. Each file contains only the annotations for that camera, making it compatible with standard SLEAP workflows.

!!! tip
    Per-camera SLP export is recommended if you plan to retrain SLEAP models on individual camera views.

### 3D Points (HDF5)

**File → Export 3D Points (H5)**

Exports triangulated 3D keypoints as an HDF5 file. Requires triangulation to have been run first.

Structure:

```
/tracks          — Track names
/node_names      — Keypoint names
/points_3d       — Shape: (n_frames, n_tracks, n_nodes, 3) — XYZ coordinates
```

### Reprojections (HDF5)

**File → Export Reprojections (H5)**

Exports the 2D reprojected points (3D points projected back to each camera view) in HDF5 format. Useful for evaluating annotation consistency.

### Calibration (TOML)

**File → Export Calibration (TOML)**

Saves the current camera calibration as a TOML file. Useful if you've modified camera parameters or want to share calibration separately.

### Skeleton (JSON)

**File → Save Skeleton (JSON)**

Exports the skeleton definition (node names and edge connections) as a JSON file.

## Project Files

### Save Project

**File → Save Project** saves a complete `.luc3d.slp` project file containing:

- All 2D annotations
- Camera calibration
- Skeleton definition
- Track and identity assignments
- Instance groups and 3D data

### Load Project

**File → Load Project** restores a previously saved project, including all calibration, annotations, and metadata.

## Python Conversion Scripts

For offline conversion, LUC3D includes Python scripts in the `scripts/` directory:

### JSON to SLP

```bash
python scripts/json_to_slp.py input.json output.slp
```

Converts the JSON export to SLEAP `.slp` format. Requires `h5py` and `numpy`.

### JSON to HDF5

```bash
python scripts/json_to_h5.py input.json output.h5
```

Converts the JSON export to HDF5 format. Requires `h5py` and `numpy`.
