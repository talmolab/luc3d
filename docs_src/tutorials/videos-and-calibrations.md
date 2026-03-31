# Tutorial: Loading Videos & Linking Calibrations from Scratch

This tutorial covers the manual workflow for when your files aren't organized in a standard session folder — loading videos individually and linking them with camera calibration data.

## When to Use This Workflow

Use this approach when:

- Videos and calibration files are in different directories
- You want to selectively load specific videos (not all from a folder)
- You're setting up a new project from scattered files
- Your folder structure doesn't match the standard session layout

## Step 1: Load Videos

1. Go to **File → Load Videos**
2. Select one or more video files (hold ++ctrl++ or ++shift++ to multi-select)
3. Supported formats: MP4, AVI, WebM, MOV

The videos appear in the viewer grid. At this point they have no camera association — they're just numbered video slots.

## Step 2: Load Calibration

1. Go to **File → Load Calibration**
2. Select your calibration file (TOML or JSON)

LUC3D parses the calibration and creates camera objects for each entry.

## Step 3: Assign Videos to Cameras

After loading both videos and calibration, LUC3D attempts to auto-match them. Check the **Session** tab (press ++i++ to open the info panel if needed):

### If Auto-Matching Worked

You'll see a table like:

| Camera | Video | Status |
|--------|-------|--------|
| back   | back_recording.mp4 | Matched |
| side   | side_cam.mp4 | Matched |
| top    | overhead.mp4 | Matched |

### If Auto-Matching Failed

Unmatched entries appear with dropdowns. Manually assign each video to its camera:

1. Find the unmatched camera in the table
2. Use the dropdown to select the correct video file
3. Repeat for all cameras

!!! tip
    Auto-matching works by comparing video filenames to camera names. If your videos are named `rec_001.mp4`, `rec_002.mp4`, etc., auto-matching won't work — you'll need to assign manually.

## Step 4: Verify the Setup

After assignment, verify everything is correct:

### Check Video Views

- Each camera view should show the correct video feed
- Navigate through frames to confirm synchronization
- All views should show the same moment in time

### Check Calibration

Open the **Cameras** tab to verify:

- All cameras have the correct resolution (should match video resolution)
- Focal lengths and principal points look reasonable
- Rotation and translation values are present

### Check the 3D Viewport

Press ++backslash++ to open the 3D viewport. You should see:

- Camera frustums (wireframe pyramids) in reasonable positions
- Cameras pointing toward a common scene area
- No cameras overlapping or at the origin (which would indicate missing extrinsics)

## Writing a Calibration File

If you don't have a calibration file yet, here's how to create one:

### Minimal TOML Template

```toml
[cam_0]
name = "back"
size = [1280, 1024]
matrix = [
    [1000.0, 0.0, 640.0],
    [0.0, 1000.0, 512.0],
    [0.0, 0.0, 1.0]
]
distortions = [0.0, 0.0, 0.0, 0.0, 0.0]
rotation = [0.0, 0.0, 0.0]
translation = [0.0, 0.0, 0.0]

[cam_1]
name = "side"
size = [1280, 1024]
matrix = [
    [1000.0, 0.0, 640.0],
    [0.0, 1000.0, 512.0],
    [0.0, 0.0, 1.0]
]
distortions = [0.0, 0.0, 0.0, 0.0, 0.0]
rotation = [0.5, 0.0, 0.0]
translation = [200.0, 0.0, 0.0]
```

### Parameter Guide

**Intrinsic matrix** (`matrix`):

```
[[fx,  0, cx],
 [ 0, fy, cy],
 [ 0,  0,  1]]
```

- `fx`, `fy` — Focal length in pixels (typically 800–2000 for standard lenses)
- `cx`, `cy` — Principal point, usually near the image center (`width/2`, `height/2`)

**Distortion coefficients** (`distortions`): `[k1, k2, p1, p2, k3]`

- Set all to `0.0` if your lens has minimal distortion or you've already undistorted the videos

**Rotation** (`rotation`): Rodrigues vector `[rx, ry, rz]`

- Represents the rotation from world coordinates to camera coordinates
- `[0, 0, 0]` means the camera is aligned with world axes

**Translation** (`translation`): `[tx, ty, tz]`

- Camera position in world coordinates (in mm or your chosen unit)

### Getting Calibration Data

Common calibration tools that produce compatible output:

- **[Anipose](https://anipose.readthedocs.io/)** — Produces TOML files directly loadable by LUC3D
- **OpenCV** — Use `cv2.calibrateCamera()` and export the parameters
- **MATLAB Camera Calibrator** — Export and convert to TOML format
- **Caltech Calibration Toolbox** — Convert output to the expected format

## Loading Additional Videos Later

You can add more videos to an existing session:

1. Go to **File → Load Videos**
2. Select the additional video files
3. Reassign camera-video pairs in the **Session** tab

## Complete Example

Here's a full workflow for setting up a 3-camera rig from scratch:

```
1. Record synchronized videos: cam1.mp4, cam2.mp4, cam3.mp4
2. Calibrate cameras with Anipose → calibration.toml
3. Open LUC3D
4. File → Load Videos → select cam1.mp4, cam2.mp4, cam3.mp4
5. File → Load Calibration → select calibration.toml
6. Open Session tab → verify camera-video assignments
7. Open 3D viewport (\ key) → verify camera positions look correct
8. Begin annotating!
```
