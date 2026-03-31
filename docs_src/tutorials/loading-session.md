# Tutorial: Loading a Session

This tutorial walks you through loading your first recording session into LUC3D, including videos, camera calibration, and skeleton setup.

## What You Need

A **session folder** with per-camera subdirectories. Each camera gets its own folder containing a video and optionally an annotation file (`.slp` or `.h5`).

```
my_session/
├── calibration.toml          # Camera calibration (filename must contain "calib")
├── skeleton.json              # Optional: skeleton definition
├── back/                      # Camera folder — name matches calibration
│   ├── video.mp4              # Video file
│   └── back.slp               # Optional: SLEAP annotations
├── side/
│   ├── video.mp4
│   └── side.slp
├── top/
│   └── video.mp4
└── front/
    └── video.mp4
```

Camera folder names like `Cam-back`, `camback`, or `cam_back` all match the calibration name `back` (case-insensitive, `cam` prefix is stripped).

## Step 1: Load the Session Folder

1. Open LUC3D in your browser
2. Go to **File → Load Session Folder** (or press ++ctrl+o++)
3. Select your session folder using the file picker

!!! note
    LUC3D uses the browser's File System Access API. You'll see a permission dialog the first time — click "Allow" to grant read access to the folder.

## Step 2: Verify Camera Matching

After loading, LUC3D automatically matches camera subdirectory names to the camera names in your calibration file.

Check the **Session** tab in the info panel (press ++i++ if it's not visible) to see the camera assignments:

| Camera | Directory | Video |
|--------|-----------|-------|
| back   | back/     | video.mp4 |
| side   | side/     | video.mp4 |
| top    | top/      | video.mp4 |
| front  | front/    | video.mp4 |

If any camera directory is missing or unmatched, a popup lets you import the missing files manually.

### How Directory Matching Works

LUC3D matches subdirectory names to calibration camera names using three rules (tried in order, case-insensitive):

1. **Exact match** — directory name equals camera name (`back/` → `back`)
2. **Cam-prefix match** — directory is `cam` + camera name (`camback/` → `back`)
3. **Strip cam** — strip `cam` from directory name (`Cam-back/` → `back`)

## Step 3: Verify the Skeleton

If your folder includes a `skeleton.json`, it's loaded automatically. Otherwise, LUC3D uses a default skeleton.

Check the **Skeleton** tab to verify:

- **Nodes** — All expected keypoint names are listed
- **Edges** — Connections between keypoints are correct

You can add or remove edges directly in the Skeleton tab.

## Step 4: Verify Calibration

Check the **Cameras** tab to confirm all cameras loaded with correct parameters:

- Camera name
- Resolution (should match your videos)
- Focal length (from the intrinsic matrix)

## Step 5: Navigate and Begin

You should now see your multi-camera views in a grid layout:

- Use ++left++ / ++right++ to step through frames
- Use ++space++ to play/pause
- Use the **timeline** at the bottom to scrub to specific frames
- Press ++v++ to cycle through single-camera views, ++g++ to return to the grid

## Loading Videos Separately

If your videos and calibration are in different locations, you can load them individually:

1. **File → Load Videos** — Select one or more video files
2. **File → Load Calibration** — Load a TOML or JSON calibration file
3. Check the **Session** tab to verify camera-video assignments

## Loading a Skeleton Separately

If you have a skeleton from another project:

1. **File → Load Skeleton** — Select a skeleton JSON file
2. Verify in the **Skeleton** tab

## Loading SLEAP Predictions

SLEAP annotations are loaded automatically if `.slp` or `.h5` files are present in the camera subdirectories. If multiple versions exist (e.g., `cam_v1.slp`, `cam_v2.slp`), LUC3D loads the highest version.

You can also load predictions manually:

1. Load your session (videos + calibration) first
2. **File → Load SLP** — Select a SLEAP `.slp` file
3. Predictions appear as **predicted instances** (dashed outlines)
4. Double-click any predicted instance to convert it to an editable user instance

## Troubleshooting

!!! warning "Videos not showing"
    - Ensure your browser supports WebCodecs (Chrome 94+ or Edge 94+)
    - Check the browser console (F12) for decode errors
    - Try re-encoding videos with `ffmpeg -i input.mp4 -c:v libx264 -pix_fmt yuv420p output.mp4`

!!! warning "Calibration not loading"
    - Verify the TOML/JSON syntax is valid
    - Filename must contain `calib` (e.g., `calibration.toml`, `my_calib.json`)
    - Ensure camera names in the calibration match your subdirectory names
    - Check that matrix values are nested arrays, not flat lists

!!! warning "Camera directories not detected"
    - Each camera must be a subdirectory at the root of the session folder
    - Directory names must match calibration camera names (with optional `cam`/`Cam-` prefix)
    - Each directory needs at least one video file (`.mp4`, `.avi`, `.webm`, `.mov`, `.mkv`)
    - Files nested deeper than one level are ignored
