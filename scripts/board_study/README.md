# board_study: compare ChArUco calibration boards across camera rigs

Takes multi-camera ChArUco calibration recordings, calibrates each one (and parts of
each one) with the same tools the rigs use, and scores every calibration the same way,
so boards can be compared within a rig and recommended per rig size.

- [PROTOCOL.md](PROTOCOL.md): what to record at the rig, and the calib.io shopping list.
- [RESULTS.md](RESULTS.md): what the recordings we already have show, and the
  recommendation.
- `studies/existing-recordings.toml`: the existing recordings that were analysed.

## Running

Python 3.11+, no install step; `uv` fetches the packages:

```bash
UVW="--with numpy --with scipy --with opencv-contrib-python-headless --with aniposelib --with matplotlib --with sleap-io"
uv run --no-project $UVW python scripts/board_study boards                  # the calib.io catalogue used here
uv run --no-project $UVW python scripts/board_study scan /path/study --out study.toml
uv run --no-project $UVW python scripts/board_study run study.toml out/     # -> out/results.json
uv run --no-project $UVW python scripts/board_study report out/             # -> out/report.md, out/figures/
```

`run` options: `--engine anipose,calibrat3` (default `anipose`), `--calibrat3 <checkout>`,
`--splits 3` (disjoint parts per recording, 0 = off), `--block-s 5`,
`--prefixes 10,20,30,45,60,90,120` (calibrations from the first N seconds, '' = off),
`--stride N` (detect every Nth frame; a take can set its own `stride`), `--rig NAME`.

Detection dominates the time: about 0.5 CPU-seconds per 1.3-megapixel frame, run on all
cores but one (an 8-camera, 90-second, 10 fps take: ~5 minutes on an M2 Pro). It is
cached in `out/cache/<take>/<camera>.npz`, so re-runs only recalibrate.

## study.toml

```toml
[study]
name = "Board comparison, November 2026"

[[take]]
id = "rig8-2026-11-03-calibio-400x300-fine_take1"   # unique
rig = "rig8"
session = "2026-11-03"          # one sitting, cameras untouched; held-out scoring stays inside it
board = "calibio-400x300-fine"  # catalogue id, or a board.toml (next to the study file or in the folder), or omit = <path>/board.toml
path = "/Volumes/falkner/.../calibio-400x300-fine_take1"   # campy/anipose folder: <Camera>/calibration_images/*.mp4, or <view>.mp4
kind = "calibration"            # or "test": the test board held still at ~12 places
# cameras = ["Camera0", "Camera1"]   # optional subset / order (default: every camera folder with a video)
# reference = "calibration.toml"     # optional: a calibration made at the time, scored like the others
# stride = 3                         # optional: detect every 3rd frame (high frame rates)
```

`[[poses]]` (proofread 2D poses, tracks named the same in every camera) and `[[ruler]]`
(a bar of known length, its two ends labelled) are described in `poses.py`.

## What is computed

For each take and each calibration engine:

| Calibration | Data it uses | Scored on |
|---|---|---|
| `full` | the whole take | its own frames; the session's test recordings, else its other takes |
| `reference` | the calibration.toml made at the time (if given) | same as `full` |
| `split1of3`… | one of 3 disjoint sets of 5-second blocks, interleaved | the test recordings, else the take's other blocks |
| `first10s`… | the first N seconds | the test recordings, else the take's last third (prefixes then come from the first two thirds) |

Measures (all with one detector, OpenCV's ChArUco detector with default settings, on
every calibration, so they compare across boards and tools but are not the numbers
calibrat3 or sleap-anipose print):

- `reprojection`: triangulate (DLT on undistorted points, as aniposelib, calibrat3 and
  LUC3D) every corner seen by ≥ 2 cameras and project it back; median / p95 pixels.
- `geometry` (held-out): triangulated corners vs the printed pattern. *Ruler error*:
  lengths between seen corners at least half the board's diagonal apart, median
  |error| in % (and mm). *Board fit*: RMS of the rigid fit to the flat pattern, mm. Also
  one-square spacing error and scale bias.
- `repeatability`: across the 3 disjoint parts of a take, and across separate takes of
  the same board in a session: SD of focal length (%), principal point (px), k1, k2;
  camera position (mm) and rotation (°) spread after aligning the calibrations' world
  frames (Procrustes on camera centres); SD of camera-to-camera distances; and the
  spread of the same held-out 3D points triangulated with each calibration (point
  clouds rigidly aligned), median mm.
- `coverage`: per camera, % of frames with ≥ 6 corners. For every frame where the
  board's pose is known from ≥ 2 *other* cameras and it lies fully inside this camera's
  image: square size in pixels, tilt from the line of sight, distance, and whether this
  camera found it. Gives detection rate vs square size / tilt, and the smallest square
  and steepest tilt still found.
- `poses` / `rulers`: see `poses.py` (reprojection and leave-one-camera-out pixel error
  of proofread poses; triangulated ruler length error).
- `truth` (simulations only): 3D error of triangulated corners against the true rig.

## Calibration engines

- `anipose` (default): aniposelib 0.8 `CameraGroup.calibrate_rows` with default
  settings, which is what sleap-anipose's `slap-calibrate` runs (one focal length and
  k1 per camera, principal point at the image centre, iterative bundle adjustment). Fed
  this study's cached detections, so splits and prefixes need no re-detection.
- `calibrat3`: the browser app the campy rigs use now
  (<https://talmolab.github.io/calibrat3/>), run headless through its own
  `tests/e2e/real-session.mjs` (detection, intrinsics with k1+k2, extrinsics, its bundle
  adjustment, TOML export). Needs a calibrat3 checkout with `tests/e2e` npm-installed;
  parts of a take are cut into frame-exact H.264 copies first. Slower (it detects again).

## Simulations

`simulate` renders catalogue boards into a copy of a real rig: cameras from a real
calibration, board motion from a real recording of that rig (`--trajectory out/
--trajectory-take <id>`: each frame's board pose, so the new board is held where the
person held the real one) or a random walk. Each frame is rendered per camera
(supersampled, with the plate's white margin, lens distortion, defocus, motion blur over
the exposure, sensor noise) and run through the same detector. `--corner-jitter` adds
noise to each detected corner for what rendering leaves out (video compression above
all); set it so a simulation of the rig's real board gives the real recording's
reprojection error. A still test-board recording is rendered too. Output is a folder of
takes plus a `study.toml` for `run`; the report then also gives `3D error vs truth`.

Not simulated: glare and uneven light, hands and cage parts hiding the board, sync
error, boards that are not perfectly flat, people handling a big board differently from
a small one.

## Files

| File | Purpose |
|---|---|
| `__main__.py` | command line |
| `boards.py` | calib.io catalogue (sizes, prices, part numbers), board.toml I/O, OpenCV board objects, ideal corner positions |
| `camgeom.py` | anipose calibration.toml read/write, projection, DLT triangulation, rigid fits |
| `detect.py` | corner detection over videos (one decode, a pool of detector processes), cache format |
| `engines.py` | calibration: aniposelib, calibrat3 (headless) |
| `metrics.py` | reprojection, board geometry, repeatability, coverage |
| `poses.py` | proofread poses and rulers |
| `study.py` | study.toml, the run, `scan` |
| `report.py` | results.json → report.md + figures |
| `simulate.py` | synthetic recordings of catalogue boards in a copy of a real rig |
