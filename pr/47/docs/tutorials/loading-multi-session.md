# Tutorial: Loading Multiple Sessions

This tutorial covers how to load and manage multiple recording sessions in a single LUC3D project. Multi-session support is useful when you have recordings from different time points, conditions, or subjects that share the same camera rig.

## Folder Structure

Each session is a subdirectory containing its own calibration file and per-camera subdirectories:

```
my_project/
├── session_01/
│   ├── calibration.toml       # Per-session calibration
│   ├── back/
│   │   ├── video.mp4
│   │   └── back.slp           # Optional: SLEAP annotations
│   ├── side/
│   │   └── video.mp4
│   └── top/
│       └── video.mp4
├── session_02/
│   ├── calibration.toml
│   ├── back/
│   │   └── video.mp4
│   ├── side/
│   │   └── video.mp4
│   └── top/
│       └── video.mp4
└── session_03/
    ├── calibration.toml
    ├── back/
    │   └── video.mp4
    └── side/
        └── video.mp4
```

Each session subdirectory is detected if it contains either a calibration file (with `calib` in the name) or at least one camera subdirectory.

## Step 1: Load the Multi-Session Folder

1. Go to **File → Load Multi-Session Folder**
2. Select the **project root folder** (the one containing the session subfolders)
3. LUC3D discovers all subdirectories and loads them as separate sessions

!!! note
    LUC3D uses the File System Access API to enumerate the folder contents. Each subdirectory containing video files becomes a session.

## Step 2: Verify Sessions

After loading, the **Sessions** sidebar on the left shows all discovered sessions:

```
Sessions
├── session_01  ← click to switch
├── session_02
└── session_03
```

- **Click** a session to switch to it — the video views update to show that session's videos
- **Double-click** a session name to rename it

## Step 3: Check Camera Assignments Per Session

Each session has its own camera-video assignments. Open the **Session** tab in the info panel to verify:

- Videos are correctly matched to camera names
- All expected cameras have videos assigned

Camera subdirectory names are matched to calibration names using the same rules as single-session loading (exact match, `cam` prefix, case-insensitive). See [Camera Setup](../user-guide/camera-setup.md#camera-directory-matching) for details.

## Working Across Sessions

### Switching Sessions

Click a session in the sidebar to switch. LUC3D loads that session's videos and annotations while preserving your work in other sessions.

### Independent Annotations

Each session maintains its own:

- Video set and camera-video assignments
- Frame annotations (instances, groups)
- Track assignments
- Triangulation data

### Shared Skeleton

The skeleton definition is shared across all sessions — changes to the skeleton (adding/removing nodes or edges) apply everywhere.

## Reorganizing Sessions

### Moving Videos Between Sessions

If a video was placed in the wrong session folder:

1. In the **Session** tab, find the video
2. Drag it to the correct session in the sidebar
3. Confirm the move in the dialog

This transfers the video and its associated annotations.

## Tips for Multi-Session Workflows

!!! tip "Consistent naming"
    Use the same camera subdirectory names across sessions (`back/`, `side/`, `top/`) so that camera auto-matching works consistently.

!!! tip "Per-session calibration"
    Each session should have its own `calibration.toml` inside the session folder. This allows for different camera positions between sessions.

!!! tip "Batch operations"
    Operations like "Group by Track & Triangulate All" run on the **active session only**. Switch sessions and run again for each session, or use the project-level export.

## Example Workflow

1. **Load** the project folder with all sessions
2. **Session 1**: Annotate poses, assign tracks, group instances, triangulate
3. Switch to **Session 2**: Repeat annotation workflow
4. Switch to **Session 3**: Repeat
5. **Export** — Each session's data is included in the project save

## Troubleshooting

!!! warning "Sessions not detected"
    - Ensure each session is a direct subdirectory of the project folder
    - Each session must contain either a calibration file (with `calib` in the name) or at least one camera subdirectory
    - Hidden folders (starting with `.`) are ignored

!!! warning "Wrong number of sessions"
    - Check that your folder structure matches the expected layout — each session needs camera subdirectories with video files
    - Subdirectories without camera folders or calibration are skipped
