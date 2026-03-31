# 3D Triangulation

LUC3D uses Direct Linear Transform (DLT) triangulation to reconstruct 3D poses from 2D annotations across multiple camera views.

## Prerequisites

Before triangulating, you need:

1. **Camera calibration** loaded (TOML or JSON with intrinsic and extrinsic parameters)
2. **2D annotations** in at least 2 camera views
3. **Instance groups** linking the same individual across views

## Triangulating a Frame

### Single Frame

Press ++t++ or go to **Edit → Triangulate Current Frame**.

LUC3D will:

1. For each instance group in the current frame, gather 2D keypoints from all linked camera views
2. Compute the 3D position of each keypoint using DLT
3. Store the 3D point cloud on the InstanceGroup
4. Generate **reprojected instances** (the 3D points projected back to each camera's 2D view)

### Multiple Frames

Go to **Edit → Triangulate Multiple Frames** to batch-triangulate a range of frames. A dialog lets you specify the start and end frames.

### Batch Triangulation

For full-session processing:

- **Edit → Group by Track & Triangulate All** — Auto-groups by track assignment, then triangulates every frame
- **Edit → Group by Identity & Triangulate All** — Auto-groups by identity, then triangulates every frame

## Reprojection Error

After triangulation, LUC3D computes the **reprojection error** — the distance (in pixels) between where a keypoint was annotated and where the triangulated 3D point projects back onto that camera view.

### Reading the Error

In the **Instances** tab of the info panel:

- **Overall RMS error** is shown per instance group
- **Per-camera errors** show which views have the worst fit
- **Per-node breakdown** highlights which keypoints are problematic

### Error Color Coding

| Error Range | Color | Meaning |
|-------------|-------|---------|
| < 2 px | Green | Excellent — annotation is consistent across views |
| 2–5 px | Yellow | Acceptable — minor inconsistencies |
| > 5 px | Red | Poor — check for annotation errors or calibration issues |

### Toggling Error Display

- Press ++e++ to toggle error visualization on the video views
- Press ++r++ to toggle reprojected instance overlays
- Use the **Visibility** tab for fine-grained control

## 3D Viewport

Press ++backslash++ or go to **View → Toggle 3D Viewport** to open the 3D visualization.

### Viewport Controls

- **Left-click + drag** — Orbit the camera
- **Scroll wheel** — Zoom in/out
- **Right-click + drag** — Pan

### Viewport Features

- **Camera frustums** — Wireframe pyramids showing each camera's position and viewing direction
- **3D skeleton** — Triangulated keypoints connected by skeleton edges
- **Color coding** — Follows the current track/identity color mode

### Viewport Buttons

| Button | Action |
|--------|--------|
| **Show Camera View** | Snap the 3D camera to match a specific camera's perspective |
| **Show Initial View** | Reset to the default orbiting viewpoint |
| **Set Env** | Freeze the current frame's 3D skeleton as a persistent reference overlay |
| **Clear Env** | Remove the environment reference overlay |

## Troubleshooting

!!! warning "High reprojection error"
    If error is consistently high across all keypoints:

    - Check that your calibration file matches the video resolution
    - Verify that camera names are correctly mapped to videos
    - Re-examine the calibration quality (try recalibrating)

!!! warning "Some keypoints have high error"
    If only specific keypoints show high error:

    - Check those keypoints in each camera view — they may be mispositioned
    - Mark occluded keypoints as occluded (right-click) rather than guessing their position
    - Keypoints visible in only 1 view cannot be triangulated

!!! note
    Triangulation requires a keypoint to be visible in at least 2 camera views. Keypoints marked as occluded or visible in only one view are excluded from 3D reconstruction.
