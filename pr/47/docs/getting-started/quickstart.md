# Quickstart

This guide walks you through a complete workflow: loading videos, annotating poses, grouping across views, triangulating 3D, and exporting.

## 1. Start the Server

```bash
cd lucid
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080) in Chrome.

## 2. Load a Session

Go to **File → Load Session Folder** (or press ++ctrl+o++) and select a folder containing your multi-camera videos and calibration file.

Your session folder should have per-camera subdirectories:

```
my_recording/
├── calibration.toml
├── back/
│   └── video.mp4
├── side/
│   └── video.mp4
└── top/
    └── video.mp4
```

LUC3D automatically matches camera subdirectory names to the camera names in the calibration file.

## 3. Annotate a Pose

1. Navigate to a frame using the timeline or arrow keys
2. Press ++n++ to create a new instance
3. Drag keypoint nodes to position them on the animal/person
4. Repeat for each camera view where the subject is visible

## 4. Group Across Views

1. Press ++a++ to enter assignment mode
2. Click the instance in each camera view that represents the same individual
3. Press ++c++ to create the group

The instances are now linked as an **InstanceGroup** — they represent the same skeleton seen from different angles.

## 5. Triangulate

Press ++t++ to triangulate the current frame. LUC3D computes 3D positions using DLT and shows:

- **Reprojected instances** (dashed outlines) on each camera view
- **Reprojection error** in the Instances tab
- **3D skeleton** in the 3D viewport (press ++backslash++ to open)

## 6. Export

Go to **File** and choose your export format:

- **Export Labels (JSON)** — All 2D annotations
- **Export 2D SLP** — SLEAP-compatible `.slp` files
- **Export 3D Points (H5)** — Triangulated 3D keypoints in HDF5

That's it! See the [User Guide](../user-guide/annotation.md) and [Tutorials](../tutorials/loading-session.md) for detailed walkthroughs.
