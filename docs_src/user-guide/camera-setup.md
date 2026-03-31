# Multi-Camera Setup

LUC3D works with multi-view recordings where the same scene is captured from multiple synchronized cameras. This page covers how to prepare your camera calibration data and organize your video files.

## Camera Calibration Format

LUC3D accepts camera calibration in **TOML** or **JSON** format. The TOML format is compatible with [Anipose](https://anipose.readthedocs.io/) calibration output.

### TOML Format

```toml
[cam_0]
name = "back"
size = [1280, 1024]
matrix = [[1000.0, 0.0, 640.0], [0.0, 1000.0, 512.0], [0.0, 0.0, 1.0]]
distortions = [0.0, 0.0, 0.0, 0.0, 0.0]
rotation = [0.1, -0.2, 0.05]
translation = [100.0, 50.0, 500.0]

[cam_1]
name = "side"
size = [1280, 1024]
matrix = [[1000.0, 0.0, 640.0], [0.0, 1000.0, 512.0], [0.0, 0.0, 1.0]]
distortions = [0.0, 0.0, 0.0, 0.0, 0.0]
rotation = [0.3, 0.1, -0.1]
translation = [-200.0, 50.0, 500.0]
```

### Calibration Parameters

| Parameter | Shape | Description |
|-----------|-------|-------------|
| `name` | string | Camera name — used to match with video filenames |
| `size` | [width, height] | Image resolution in pixels |
| `matrix` | 3x3 | Intrinsic camera matrix (focal length + principal point) |
| `distortions` | [k1, k2, p1, p2, k3] | Lens distortion coefficients (OpenCV model) |
| `rotation` | [rx, ry, rz] or 3x3 | Rotation as Rodrigues vector or rotation matrix |
| `translation` | [tx, ty, tz] | Translation vector (camera position in world coordinates) |

### JSON Format

```json
{
  "cameras": [
    {
      "name": "back",
      "size": [1280, 1024],
      "matrix": [[1000, 0, 640], [0, 1000, 512], [0, 0, 1]],
      "distortions": [0, 0, 0, 0, 0],
      "rotation": [0.1, -0.2, 0.05],
      "translation": [100, 50, 500]
    }
  ]
}
```

## Folder Structure

LUC3D expects a **per-camera subdirectory** structure. Each camera has its own folder containing a video file and optionally an annotation file (`.slp` or `.h5`).

### Single Session

```
session/
├── calibration.toml          # Camera calibration (filename must contain "calib")
├── skeleton.json              # Optional: skeleton definition
├── back/                      # Camera subdirectory (name matches calibration)
│   ├── video.mp4              # Video file for this camera
│   └── back.slp               # Optional: SLEAP annotations
├── side/
│   ├── video.mp4
│   └── side.slp
├── top/
│   └── video.mp4
└── front/
    └── video.mp4
```

### Multi-Session

```
project/
├── session_01/
│   ├── calibration.toml       # Each session has its own calibration
│   ├── back/
│   │   ├── video.mp4
│   │   └── back.slp
│   ├── side/
│   │   └── video.mp4
│   └── top/
│       └── video.mp4
└── session_02/
    ├── calibration.toml
    ├── back/
    │   └── video.mp4
    ├── side/
    │   └── video.mp4
    └── top/
        └── video.mp4
```

### File Discovery Rules

| File Type | Location | Naming Rule |
|-----------|----------|-------------|
| Calibration | Session root | Filename must contain `calib` (e.g., `calibration.toml`, `my_calib.json`) |
| Skeleton | Session root | Filename must contain `skeleton` and end in `.json` (optional) |
| Video | Camera subdirectory | Any `.mp4`, `.avi`, `.webm`, `.mov`, or `.mkv` file (first file used) |
| Annotations | Camera subdirectory | Any `.slp` or `.h5` file (highest version loaded if multiple) |
| Environment | Camera subdirectory | `.slp`/`.h5` files with `.externals.` in the name |

!!! note "Annotation versioning"
    If a camera folder contains multiple SLP files with version suffixes (e.g., `cam1_v1.slp`, `cam1_v2.slp`, `cam1_v3.slp`), LUC3D automatically loads the highest version number.

## Camera Directory Matching

LUC3D matches camera subdirectory names to the `name` field in the calibration file using these rules (case-insensitive):

| Calibration `name` | Matching Directory Names |
|--------------------|--------------------------|
| `back` | `back`, `Cam-back`, `camback`, `cam_back` |
| `side` | `side`, `Cam-side`, `camside`, `cam_side` |
| `top` | `top`, `Cam-top`, `camtop`, `cam_top` |

The matching logic strips `cam` prefixes and is case-insensitive. If auto-matching fails, a popup lets you import missing files manually.

## Anipose Compatibility

If you use [Anipose](https://anipose.readthedocs.io/) for calibration, you can directly load its `calibration.toml` output. LUC3D supports both the Rodrigues vector and rotation matrix formats that Anipose produces.

## Tips

- Camera subdirectory names should match the `name` field in your calibration file
- Each camera folder needs exactly one video file
- All videos in a session should have the same number of frames for synchronized playback
- Ensure calibration was performed with the same resolution as your recording videos
- Sessions without a calibration file can still load videos, but 3D features will be disabled
