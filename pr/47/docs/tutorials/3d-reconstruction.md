# Tutorial: 3D Reconstruction

This tutorial covers the complete workflow from 2D annotations to 3D pose reconstruction, including grouping, triangulation, validation, and export.

## Prerequisites

Before starting 3D reconstruction, you need:

- [x] Multi-camera videos loaded
- [x] Camera calibration loaded (TOML or JSON)
- [x] 2D annotations in at least 2 camera views per subject
- [x] Skeleton loaded with correct node/edge definitions

## Step 1: Group Instances Across Views

Triangulation requires knowing which instances across cameras represent the same individual. You do this by creating **Instance Groups**.

### Manual Grouping

1. Press ++a++ to enter **assignment mode** (or click the Assignment button in the toolbar)
2. Click an ungrouped instance in Camera 1 — it gets highlighted
3. Click the corresponding instance (same individual) in Camera 2
4. Click in Camera 3, Camera 4, etc. as needed
5. Press ++c++ or ++enter++ to create the group

The instances are now linked. You'll see them listed together in the **Instances** tab.

### Auto-Grouping by Track

If you've assigned [tracks](../user-guide/tracks-identities.md) consistently across views:

1. Go to **Edit → Group by Track & Triangulate All**
2. LUC3D automatically groups instances that share the same track across cameras
3. Triangulation runs immediately after grouping

### Auto-Grouping by Identity

Similarly, if you've assigned identities:

1. Go to **Edit → Group by Identity & Triangulate All**
2. Groups instances by identity and triangulates

## Step 2: Triangulate

### Single Frame

With groups created, press ++t++ to triangulate the current frame.

LUC3D performs **Direct Linear Transform (DLT)** triangulation:

1. For each keypoint, gathers 2D positions from all cameras in the group
2. Solves for the 3D position that minimizes reprojection error
3. Stores the 3D point cloud on the Instance Group
4. Computes reprojected 2D positions for all cameras

### Batch Triangulation

- **Edit → Triangulate Multiple Frames** — Specify a frame range
- **Edit → Group by Track & Triangulate All** — Groups and triangulates every frame

## Step 3: Validate with Reprojection

After triangulation, check quality using reprojection error.

### Enable Visualizations

- Press ++r++ to show **reprojected instances** (dotted outlines on each camera view)
- Press ++e++ to show **error coloring** on keypoints

### Read the Error

In the **Instances** tab:

- **Green** (< 2px): Excellent consistency
- **Yellow** (2–5px): Acceptable
- **Red** (> 5px): Needs attention

### Investigate High Error

If a keypoint has high error:

1. Check the **per-camera breakdown** — which camera is the outlier?
2. Go to that camera view and compare:
    - Your annotated keypoint position (solid node)
    - The reprojected position (dotted overlay)
3. If the reprojection looks correct, adjust your annotation toward it
4. Re-triangulate (++t++) to update

## Step 4: Inspect in 3D

Press ++backslash++ to open the 3D viewport.

### What to Check

- **Skeleton shape** — Does the 3D skeleton look anatomically correct?
- **Scale** — Is the skeleton the right size relative to the camera positions?
- **Limb lengths** — Are bone lengths consistent and reasonable?
- **Joint angles** — No impossible bends or self-intersections?

### Navigation

- **Orbit**: Left-click + drag
- **Zoom**: Scroll wheel
- **Pan**: Right-click + drag
- **Snap to camera**: Click "Show Camera View" to see the scene from a specific camera's perspective
- **Reset view**: Click "Show Initial View"

### Environment Reference

To compare across frames:

1. Find a frame with good triangulation
2. Click **Set Env** — the current 3D skeleton becomes a persistent ghost
3. Navigate to other frames to compare
4. Click **Clear Env** when done

## Step 5: Iterate

The reconstruction workflow is iterative:

```
Annotate → Group → Triangulate → Check Error → Fix Annotations → Re-triangulate
```

Repeat until reprojection errors are consistently low (< 2–3px).

### Common Fixes

| Problem | Solution |
|---------|----------|
| High error on one keypoint | Reposition it in the camera with highest error |
| High error in one camera | Review all keypoints in that camera view |
| High error everywhere | Check grouping — wrong instances may be linked |
| 3D skeleton looks wrong | Compare against reprojection, fix the worst outliers |
| Inconsistent bone lengths | Check for left/right swaps or identity swaps |

## Step 6: Export 3D Data

Once satisfied with the reconstruction:

### Export 3D Points

**File → Export 3D Points (H5)** — Saves triangulated XYZ coordinates as HDF5:

```
/tracks          — Track names
/node_names      — Keypoint names
/points_3d       — Shape: (n_frames, n_tracks, n_nodes, 3)
```

### Export Reprojections

**File → Export Reprojections (H5)** — Saves the 2D reprojected positions for analysis.

### Export 2D Labels

**File → Export 2D SLP (Per Camera)** — Exports corrected 2D annotations as SLEAP files, one per camera view. Useful for retraining SLEAP models.

## Tips for Best Results

!!! tip "More cameras = better accuracy"
    Keypoints visible in 3+ cameras produce more robust triangulations than 2-camera reconstructions.

!!! tip "Mark occluded keypoints"
    Right-click to mark keypoints as occluded rather than guessing positions. Guessed positions add noise to triangulation.

!!! tip "Check calibration quality"
    If all keypoints consistently have high error, the issue may be with calibration rather than annotations. Try recalibrating.

!!! tip "Use the 3D viewport often"
    The 3D view catches errors that aren't obvious in 2D — like a limb bending the wrong way or passing through the body.
