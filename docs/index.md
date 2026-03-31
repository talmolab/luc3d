<div style="text-align: center; margin-bottom: 2em;">
  <img src="assets/logo.png" alt="LUC3D Logo" style="max-width: 500px; width: 100%;">
</div>

# LUC3D — Label Unification and Correspondence in 3D

**LUC3D** (pronounced lu·​cid) is a browser-based multi-view pose annotation GUI for 3D animal and human pose estimation. It runs entirely in the browser with no build system — pure vanilla JS served as static files.

## Key Features

- **Multi-view synchronized video playback** — Load videos from multiple camera angles and scrub through them in sync
- **2D pose annotation** — Create and edit skeleton instances with keypoints directly on video frames
- **Cross-view instance grouping** — Link the same individual across camera views to establish 3D correspondences
- **DLT triangulation** — Reconstruct 3D poses from 2D annotations using camera calibration data
- **[Reprojection-aided labeling](tutorials/reprojection-aided-labeling.md)** — Label 2 views, get free annotations in all other views via 3D reprojection
- **Reprojection error visualization** — Validate annotation quality with per-keypoint error overlays
- **Interactive 3D viewport** — Visualize triangulated skeletons in a Three.js 3D scene with camera frustums
- **Track and identity management** — Assign tracks and identities to instances for multi-animal tracking
- **SLEAP-compatible I/O** — Import predictions from SLEAP and export annotations in `.slp`, JSON, and HDF5 formats
- **Multi-session support** — Work with multiple recording sessions in a single project
- **Timeline widget** — SLEAP-style timeline for navigating frames, tracks, and labeled regions

## How It Works

```
Load Videos + Calibration → Annotate 2D Poses → Group Across Views → Triangulate 3D → Export
```

1. **Load** your multi-camera videos and camera calibration (TOML or JSON)
2. **Annotate** 2D keypoints on each camera view
3. **Group** corresponding instances across views (same animal/person)
4. **Triangulate** to reconstruct 3D points and verify with reprojection error
5. **Export** as SLEAP `.slp`, JSON labels, or HDF5 3D points

## Quick Links

- [Installation](getting-started/installation.md) — Get LUC3D running locally
- [Quickstart](getting-started/quickstart.md) — End-to-end walkthrough in 5 minutes
- [Loading a Session](tutorials/loading-session.md) — Load your first recording session
- [Annotating Poses](tutorials/annotating.md) — Create and edit pose annotations
- [Keyboard Shortcuts](user-guide/shortcuts.md) — Full shortcut reference

## Requirements

- A modern browser with WebCodecs support (Chrome 94+, Edge 94+)
- Python 3 for local serving (or any static file server)
- No installation or build step required
