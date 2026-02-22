# LUCID — Label Unification and Correspondence in 3D

## Background

LUCID is a browser-based tool for manually reviewing and correcting multi-camera animal pose estimation data. It is part of the [vibes.tlab.sh](https://vibes.tlab.sh) collection of self-contained HTML tools built by the [Talmo Lab](https://talmolab.org).

The tool is designed for the [SLEAP](https://sleap.ai) motion capture ecosystem. It lets users load synchronized multi-view videos with camera calibration, visualize 2D pose predictions across views, manually correct keypoints, link detections across cameras into cross-view tracks, triangulate 3D poses via Direct Linear Transform (DLT), and export corrected labels in formats compatible with SLEAP and sleap-3d.

## Architecture

The application is a **zero-dependency single-page application** — no build step, no npm, no frameworks. All logic is vanilla JavaScript split across modules loaded as global scripts. External libraries are pulled from CDN:

- **MP4Box.js** (`mp4box@0.5.2`) — MP4 demuxing for frame-accurate video decoding
- **Three.js** (`three@0.147.0`) — 3D rendering for the triangulated skeleton viewport
- **OrbitControls** (Three.js addon) — mouse-driven 3D camera control
- **dockview-core** (ESM) — split-panel drag-and-drop docking system for video views
- **h5wasm** (`h5wasm@0.8.8`) — HDF5 reading/writing in Web Worker for SLP file import and H5 export

Data flow:

```
Load videos (File API) → OnDemandVideoDecoder (WebCodecs + MP4Box)
Load SLP (.slp) → Web Worker (h5wasm) → skeleton, tracks, frames, calibration
Load calibration (.toml/.json) → Camera objects (intrinsics + extrinsics)
                                      ↓
        Session holds FrameGroups (per-frame) + InstanceGroups (cross-view tracks)
                                      ↓
        User edits keypoints → Interaction manager → Overlays re-render on canvas
                                      ↓
        Triangulate (DLT) → 3D points → Viewport3D (Three.js) + reprojection overlays
                                      ↓
        Export → JSON / H5 / TOML → .slp / .h5 / .json / .toml
```

## UI Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ File  Edit  View  Load Demo                              (Menu bar)│
├─────────────────────────────────────────────────────────────────────┤
│ +Inst -Inst │ Assign CreateGroup │ Triangulate │ NodeSize │        │
│ ☐Detected ☐Reproj ☐Errors ☐Labels           [Hide Panel] (Toolbar)│
├──────┬─────────────────────────┬──────────┬─────────────────────────┤
│ Views│                         │          │ [Instances][Videos]     │
│ ───  │  Dockview Panel System  │   3D     │ [Cameras][Skeleton]    │
│ back │  (drag & drop panels,  │ Viewport │ [Session]              │
│ mid  │   split views,         │          │                         │
│ side │   duplicate panels)    │ (Three.js│  Info Panel             │
│ top  │                        │  scene)  │  (collapsible)          │
│      │                        │          │                         │
│(Left │  Video cells with      │          │                         │
│ strip│  overlay canvases      │          │                         │
│ side │  + zoom/pan controls   │          │                         │
│ bar) │  + "Zoomed" indicator  │          │                         │
├──────┴─────────────────────────┴──────────┴─────────────────────────┤
│ [Timeline - track occupancy bars, frame markers, zoom/pan]         │
├────────────────────────────────────────────────────────────────────┤
│ 42/1000  |◄ ◄ ▶ ►| ►|  ══════════●═══════  (30.0 fps) (Controls) │
├────────────────────────────────────────────────────────────────────┤
│ ● Ready                           Instances: 2  Error: 1.23 px    │
└────────────────────────────────────────────────────────────────────┘
```

### Key UI Features

- **View strip** (left sidebar, 64px): Thumbnails of all loaded videos. Drag into the dock to display. Double-click to add. Status dots show dock state.
- **Dockview panel system**: Split-panel drag-and-drop docking (via dockview-core). Supports duplicate views of the same video with independent zoom/pan. Tabs show view names (lowercase). Views can be split horizontally/vertically or tabbed together.
- **Zoom/pan per panel**: Scroll-wheel zoom (cursor-centered), click-drag to pan when zoomed, box-zoom at 1x. Each panel instance has independent zoom state even when showing the same video. A "Zoomed" indicator appears (changes to "Unzoom" on hover as a clickable reset button).
- **3D viewport**: Three.js scene with ground-plane grid, camera frustum pyramids (only shown when real calibration is loaded — dummy extrinsics are skipped), triangulated skeleton. Click a camera to animate to its viewpoint.
- **Info panel** (right sidebar, 300px): Six tabs — Instances (reprojection error, linked/unlinked tables), Videos (list + details), Cameras (calibration params), Skeleton (add/remove/rename nodes & edges, load/save), Session (summary + camera-video assignment + shortcuts). Toggle via toolbar button on the right edge.
- **Split-pane resizing**: Ghost-line drag handles between video dock/3D viewport/info panel. Handles auto-hide when adjacent panels are collapsed.
- **Editable frame number**: Double-click the frame counter to type a specific frame number (validates integer, in-range).
- **Editable FPS**: Double-click the FPS pill to change playback rate. Initial FPS is blank until a video is loaded, then auto-set from the first video's actual framerate. Styled as a rounded pill.
- **Timeline**: Canvas-based track occupancy with frame markers. Click/drag to seek, scroll to zoom, middle-click to pan.
- **Single-view mode**: Press `V` to toggle between grid and single-view mode. `Shift+V` cycles through views. `G` returns to grid mode.

## File Reference

### Core application

| File | Lines | Purpose |
|------|-------|---------|
| `index.html` | ~5800 | Entry point. Contains all HTML structure (menu bar, toolbar, view strip, dockview video dock, 3D viewport panel, timeline, controls bar, status bar, info panel) and the main application initialization/wiring script. Includes `VideoPaneRenderer` (dockview IContentRenderer), `paneManager` (docking logic), `handleLoadSlp()`, `handleLoadVideos()`, `handleLoadCalibration()`, `handleLoadSession()`, `handleAddSlp()`, camera-video assignment UI, and all UI setup. |
| `styles.css` | ~1590 | Dark-theme stylesheet. CSS custom properties for colors, flexbox layout, responsive breakpoints (collapses panels at <900px, goes vertical at <640px), view-strip sidebar, dockview theme overrides (.dockview-theme-abyss), unzoom button, FPS pill, split-handle drag styles, info-panel-wrapper, panel tab squeeze, styled scrollbars, toggle switches, menus, and loading spinner. |

### JavaScript modules

All modules define classes/functions in the global scope (no ES module imports). The main `index.html` script tag uses `type="module"` for the dockview ESM import.

| File | Lines | Purpose |
|------|-------|---------|
| `pose-data.js` | ~980 | **Data model.** Core classes: `Skeleton` (nodes + edges), `Camera` (intrinsics K, distortion, rotation/translation, projection), `Instance` (2D keypoints for one view), `UnlinkedInstance`, `FrameGroup` (all instances at a frame), `InstanceGroup` (cross-view linked track), `Session` (top-level container mapping frames → data, with `renameCameraInAllData()` and merge support). |
| `file-io.js` | ~1270 | **File loading and export.** Parses calibration from TOML (sleap-io format) or JSON. Picks video files. Exports labels as JSON, calibration as TOML, 3D points as JSON, SLP-compatible JSON, and HDF5 formats (SLP H5, 3D points H5, reprojections H5). Skeleton serialization/deserialization. Auto-assigns videos to cameras by name matching. |
| `video.js` | ~1500 | **Video decoding and playback.** `OnDemandVideoDecoder` uses the WebCodecs API with MP4Box for demuxing, providing frame-accurate seeking with an LRU cache (60 frames) and lookahead (10 frames). Decode timeout scales with GOP length for long videos. `VideoController` synchronizes multi-view playback, manages per-view zoom/pan state, and provides `applyZoom()` with cursor-centered zooming. |
| `interaction.js` | ~1390 | **User interaction.** `InteractionManager` class handling mouse/keyboard events. Hit-testing for node selection, drag-to-move keypoints, double-click to convert predicted→user, right-click to toggle visibility, assignment mode for linking unlinked detections across views. Coordinate transforms from CSS canvas space to video pixel space. Alt+drag for box-zoom. |
| `overlays.js` | ~1490 | **Canvas rendering.** Draws skeletons (edges + nodes) on overlay canvases atop each video. Handles reprojected 3D skeletons with dashed lines and error-colored X markers. Coordinate transforms between video pixels and canvas pixels (handles letterboxing/pillarboxing). 8-color track palette. Labels overlay with node names. |
| `timeline.js` | ~1050 | **Timeline widget.** Canvas-based SLEAP-style timeline showing track occupancy per frame. Click-to-seek, drag-to-scrub, shift-drag for range selection, mouse wheel zoom, middle-click pan. Color-coded markers for user/predicted/modified frames. |
| `triangulation.js` | ~550 | **3D reconstruction.** Pure JS implementation of DLT (Direct Linear Transform) triangulation. Builds a linear system from 2D observations across cameras and solves via SVD (Jacobi eigenvalue decomposition on AᵀA). Computes per-point reprojection error. Undistortion support. |
| `viewport3d.js` | ~1010 | **3D viewport.** Three.js scene rendering triangulated skeleton keypoints, edges, camera frustum wireframes (skipped for cameras with dummy extrinsics), and labels. OrbitControls for navigation. Raycaster for clicking camera frustums to match the 2D view. Z-up world convention with grid plane. Initial camera at (800, -800, 600). |
| `demo-data.js` | ~400 | **Synthetic data.** Generates a 4-camera calibration rig (back, mid, side, top at ~300-400mm radius), a 6-node mouse skeleton, and animated 3D keypoints following circular motion with undulation. Used for testing without real data. |
| `slp-import-worker.js` | ~440 | **SLP import worker.** Web Worker using h5wasm to parse SLEAP `.slp` (HDF5) files. Extracts metadata (skeleton), tracks, frames/instances/points datasets, video references (embedded or external), and calibration from session data. Returns structured data for the main thread to build a Session. |
| `slp-package-reader.js` | ~450 | **SLP package reader.** Reads `.slp` files as ZIP/HDF5 packages to extract embedded video data and metadata. Used by the frame worker for on-demand frame extraction from embedded videos. |
| `frame-worker.js` | ~170 | **Frame extraction worker.** Web Worker that extracts individual video frames from embedded SLP video data on demand. Works with `slp-package-reader.js` to provide frame-accurate access to embedded videos without decoding the entire file upfront. |
| `slp-merge.js` | ~165 | **SLP merge utility.** Functions for merging additional SLP data into an existing session — adds new cameras, merges frame groups, and handles track/instance conflicts when combining multiple SLP files. |

### Sample data

| Path | Purpose |
|------|---------|
| `sample_session/board.toml` | Camera calibration file (TOML format) for 4 views |
| `sample_session/back.mp4` | Video from the "back" camera |
| `sample_session/mid.mp4` | Video from the "mid" camera |
| `sample_session/side.mp4` | Video from the "side" camera |
| `sample_session/top.mp4` | Video from the "top" camera |
| `sample_session/splats/` | Gaussian splat data — `manifest.json` lists per-frame `.ply` files and training config, `frames/` contains per-camera reference images |

### Documentation

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | Claude Code project instructions (architecture, local dev, dependencies) |
| `PROJECT.md` | This file — comprehensive project documentation |
| `prompts/prompts.md` | Development prompt instructions |
| `prompts/plan-*.md` | Implementation plans for each prompt |

### Tests

| Path | Purpose |
|------|---------|
| `tests/test-runner.html` | Browser-based test runner that loads all test suites |
| `tests/test-framework.js` | Minimal custom test framework (assert helpers) |
| `tests/test-pose-data.js` | Unit tests for Skeleton, Camera, Instance, Session |
| `tests/test-file-io.js` | Tests for TOML/JSON parsing and export serialization |
| `tests/test-interaction.js` | Tests for hit detection and coordinate transforms |
| `tests/test-overlays.js` | Tests for skeleton rendering and canvas transforms |
| `tests/test-triangulation.js` | Tests for DLT math and matrix operations |
| `tests/test-integration.js` | End-to-end workflow tests |
| `tests/test-regressions.js` | Regression tests for previously fixed bugs |
| `tests/test-assignment.js` | Tests for camera-video auto-assignment |
| `tests/test-drag-freeze.js` | Tests for drag interaction freeze bug |
| `tests/test-instance-drag.js` | Tests for instance dragging behavior |
| `tests/test-labels.js` | Tests for label display and rendering |
| `tests/test-multi-video.js` | Tests for multi-video loading scenarios |
| `tests/test-phase6.js` | Phase 6 feature tests |
| `tests/test-phase7.js` | Phase 7 feature tests |
| `tests/test-project-triangulation.js` | Tests for project-level triangulation |
| `tests/test-slp-merge.js` | Tests for SLP merge functionality |
| `tests/test-timeline.js` | Tests for timeline widget |
| `tests/test-video-controller.js` | Tests for video controller playback |
| `tests/test-video-mgmt.js` | Tests for video management |
| `tests/test-view-mode.js` | Tests for single-view/grid view mode switching |

### Python export scripts

| Path | Purpose |
|------|---------|
| `scripts/json_to_h5.py` | Converts the 3D points JSON export to HDF5 (compatible with sleap-3d). Usage: `uv run scripts/json_to_h5.py points3d.json output.h5` |
| `scripts/json_to_slp.py` | Converts the labels JSON export to a SLEAP `.slp` file (HDF5 format). Usage: `uv run scripts/json_to_slp.py labels.json output.slp` |

## How to Start the Server

This project runs on an SSH cluster. There is **no backend server** — it's a static site served over HTTP:

```bash
# SSH into the cluster, then from the repo root:
cd /root/vast/joshua/lucid

# Start a static file server on port 8080
python3 -m http.server 8080 --bind 0.0.0.0

# The app is now available at:
http://localhost:8080/
#
# If accessing from your local machine via SSH tunnel:
ssh -L 8080:localhost:8080 <user>@<cluster-host>

# Then open in your browser:
http://localhost:8080

# Stop the server:
# Press Ctrl+C in the terminal where it's running

# If running in the background (e.g. started with &), find and kill it:
#   lsof -i :8080          # find the PID
#   kill <PID>             # stop it
#
# Or as a one-liner:
#   kill $(lsof -t -i :8080)
```

To run the test suite, navigate to `http://localhost:8080/tests/test-runner.html`.

### Running Python export scripts

```bash
# Convert exported 3D points to HDF5
uv run scripts/json_to_h5.py points3d.json output_points3d.h5

# Convert exported labels to SLEAP .slp format
uv run scripts/json_to_slp.py labels_export.json output.slp
```

## Menu Structure

### File menu
- New Project — Reset everything
- Save Project — Save full session as JSON (cameras, skeleton, tracks, instances, video manifest)
- Load Project... — Restore a saved project JSON
- *(separator)*
- Load Videos... — Pick `.mp4`/`.avi`/`.webm`/`.mov` files
- Load Calibration... — Pick `.toml`/`.json` calibration file
- Load Session... — Pick `.json` session file
- Load SLP... — Pick `.slp`/`.h5` file (SLEAP labels)
- Load 3D Points (H5)... — Pick `.h5` file with triangulated 3D points
- Load Skeleton... — Pick `.json` skeleton definition
- Load Demo Session — Built-in 4-camera demo
- *(separator)*
- Save Skeleton (JSON) — Export skeleton definition
- Export Labels (JSON) — Export 2D annotations
- Export SLP (JSON) — Export SLEAP-compatible JSON
- Export SLP (H5) — Export SLEAP `.slp` HDF5 file directly
- Export 3D Points (JSON) — Export triangulated 3D keypoints
- Export 3D Points (H5) — Export 3D keypoints as HDF5
- Export Reprojections (H5) — Export reprojected 2D points as HDF5
- Export Calibration (TOML) — Export camera calibration

### Edit menu
- Add Instance (`N`)
- Delete Instance (`Del`)
- *(separator)*
- Unlink Group (`U`)
- *(separator)*
- Triangulate (`T`)
- Triangulate All Frames

### View menu
- Toggle 3D Viewport (`3`)
- Toggle Timeline
- Toggle Info Panel (`I`)
- *(separator)*
- Reset 3D View
- Fit 3D to Scene

### Load Demo (standalone menu bar item)

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Toggle playback |
| `←` / `→` | Previous / next frame |
| `Shift+←` / `Shift+→` | Skip 10 frames |
| `Home` / `End` | First / last frame |
| `+` / `-` | Zoom in / out (all views) |
| `0` | Reset zoom (all views) |
| `N` | Add new instance |
| `Del` | Delete selected instance |
| `T` | Triangulate current frame |
| `A` | Enter assignment mode |
| `I` | Toggle info panel |
| `3` | Toggle 3D viewport |
| `V` | Toggle single-view / grid mode |
| `Shift+V` | Cycle single view (previous) |
| `G` | Return to grid mode |
| Scroll wheel | Zoom per-panel (cursor-centered) |
| Click-drag (when zoomed) | Pan |
| Alt+drag | Box zoom |
| Double-click node | Convert predicted → user |
| Right-click node | Toggle node visibility |

## Data Loading Options

| Method | Menu Path | Formats | What It Provides |
|--------|-----------|---------|-----------------|
| Load Videos | File > Load Videos... | `.mp4`, `.avi`, `.webm`, `.mov` | Video frames for viewing. Camera names derived from filenames. Auto-assigned to calibration cameras by name. |
| Load Calibration | File > Load Calibration... | `.toml`, `.json` | Camera intrinsics + extrinsics. Updates 3D viewport with camera pyramids. Auto-renames views to match camera names. |
| Load Session | File > Load Session... | `.json` | Full session restore: cameras, skeleton, tracks, per-frame instances. |
| Load SLP | File > Load SLP... | `.slp`, `.h5` | SLEAP labels with skeleton, tracks, 2D pose data, calibration. Supports embedded videos (extracted via frame worker) or prompts for external video files. |
| Load 3D Points | File > Load 3D Points (H5)... | `.h5` | Pre-computed triangulated 3D keypoints. |
| Load Skeleton | File > Load Skeleton... | `.json` | Skeleton definition (nodes + edges). |
| Load Demo | Load Demo (menu bar) | — | Built-in 4-camera demo with synthetic skeleton, calibration, and animated poses. |
| Add SLP (merge) | File > Load SLP... (when session exists) | `.slp` | Merge additional SLP data into existing session. |

## Current State

- **Repository:** `/root/vast/joshua/lucid` on `main` branch
- **Status:** Working application with full feature set: dockview-based multi-view video playback with view strip sidebar, independent zoom/pan per panel, SLP file import (embedded + external videos), SLP merge, calibration loading, 2D pose editing, cross-view instance linking, DLT triangulation, 3D viewport (with dummy-extrinsic filtering), editable frame number and FPS pill, single-view mode, camera-video assignment, skeleton load/save, and export to multiple formats (JSON, H5, TOML, SLP)
- **Sample data included:** 4-camera video set with calibration and Gaussian splat data in `sample_session/`
- **Test suite:** 21 test files covering data model, file I/O, interaction, rendering, triangulation, integration, regressions, SLP merge, timeline, video controller, view modes, and more
