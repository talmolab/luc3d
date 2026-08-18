# Where the data lives

Every path the paper's two corpora are read from: videos, per-camera 2D pose,
3D reconstructions, reprojections, and calibration. Written 2026-08-17 by reading
the disk, not from memory — every path below was checked to exist, and every array
shape, unit and count was read out of the file it describes.

Two roots, on two different mounts:

| Corpus | Root | Sessions | Frames | Cameras | fps | Animals | On-disk |
|---|---|---|---|---|---|---|---|
| **SLAP-2M** | `/root/talmolab-smb/eric/slap_2m` | 74 (84 dirs) | 1,954,440 | 8 | 30 | 1–4 | ~450 GB |
| **Mouse-Dyad-10M** | `/root/vast/eric/BMimica` | 56 | 10,084,734 | 5 | 150.1 | 2 | 205 GB |

The corpus names are frame counts: 1.95 M and 10.08 M reconstructed frames. Both
numbers come from `figs/out/fig6.json`, which is the machine-readable inventory
(see [Derived layer](#derived-layer)).

**SLAP-2M is on the SMB mount** (`/root/talmolab-smb`) and Mouse-Dyad-10M is on local vast.
That asymmetry matters in practice: SMB reads are slow enough that `du` on one date
directory takes ~40 s, and any script that walks all 74 SLAP-2M sessions should
cache rather than re-read.

---

## SLAP-2M — `/root/talmolab-smb/eric/slap_2m`

### Layout

```
slap_2m/
├── master_sheet.xlsx                  <- THE DEFINITION OF THE CORPUS (74 rows)
└── <date>/<session>/                  <- 2022-10-07 (41), 10-19 (16), 10-20 (5),
    │                                     10-21 (5), 10-30 (17) = 84 dirs
    ├── calibration.toml               <- intrinsics + extrinsics, 8 cameras
    ├── alignment.toml                 <- cage->world rigid transform + 24 cage points
    ├── points3d.h5                    <- 3D in the CALIBRATION frame, mm
    ├── aligned_points3d.h5            <- 3D floor-aligned, mm  (what figures use)
    ├── aligned_cage_points3d.h5       <- the reconstructed cage, 24 corners, mm
    ├── reprojections.h5               <- 3D reprojected into all 8 views, px
    ├── back/ backL/ mid/ midL/        <- one directory per camera
    │   side/ sideL/ top/ topL/
    └── image_volumes/ grid_volumes/ targets/   (calibration intermediates)
```

`84 directories but 74 sessions` — the corpus is whatever `master_sheet.xlsx` lists,
not what is on disk; ten session directories are not part of it. Any script that
walks the tree instead of the sheet silently changes the n (`figs/fig6_measure.py`
documents this and reads the sheet).

### Per-camera directory

Example, `2022-10-07/10072022180149/mid/`:

| File | What it is |
|---|---|
| `mid-…-0000_h265_CRF12_denoised.mp4` | **the video**. 1280×1024, ~480 MB per camera per session |
| `…_CRF30_denoised.mp4.predictions.slp` | raw SLEAP 2D predictions |
| `…_CRF30_denoised.mp4.predictions.proofread.slp` | **proofread 2D** (only where a view was proofread) |
| `…_CRF30_denoised.mp4.predictions.proofread.slp.analysis.h5` | the same, as an analysis HDF5 — this is what scripts read |
| `…_CRF30_denoised.mp4.reprojections.slp` | 3D reprojected back into this view |
| `…_CRF30_denoised.mp4.reprojections.slp.h5` | the same, as HDF5 |
| `…_CRF12_denoised.mp4.predictions.static.externals.slp` | the same predictions with a **relative** video path — the one variant that resolves on this machine |
| `calibration_images/` | checkerboard frames |

**Two separate naming traps here, and only one of them bites.**

*Filenames say CRF30; the only video on disk is CRF12.* Harmless: every `.slp`'s
embedded `videos_json` actually points at the **CRF12** file, so the `CRF30` in the
filename is a stale label on the prediction run, not a missing input.

*Embedded video paths are dead on this machine.* This one bites. Opening any of these
`.slp` files in a tool that resolves `videos_json` requires re-linking, because three
of the four variants carry an absolute path from the machine that wrote them:

| Variant | Embedded video path |
|---|---|
| `*.predictions.slp` | `/home/runner/talmodata-smb/sean/3D_Datasets/<date>/<session>/mid/…CRF12_denoised.mp4` (a CI runner) |
| `*.predictions.proofread.slp` | `G:/.shortcut-targets-by-id/1ABZ…/2021-10-27_Talmo/Scratch/Proofreading/<date>/<session>/mid\…CRF12_denoised.mp4` (a Windows Google Drive mount, backslash separators) |
| `*.reprojections.slp` | the same `G:` path |
| `*.static.externals.slp` | `<date>/<session>/mid/…CRF12_denoised.mp4` — **relative**, resolves from the corpus root |

So: read poses from the `.analysis.h5` twins where they exist (no video needed), and
when you do need the `.slp` with pixels, prefer `.static.externals.slp` or re-link.

**The fps trap.** The mp4 container reports 30 fps and the master sheet's own
`frames / duration` gives exactly 30.0 fps on every session — but
`figs/fig6_measure.py` falls back to a hard-coded `default_fps=50.0` because
`points3d.h5` carries no `recording_frame_rate` dataset. So `fig6.json`'s SLAP-2M
`fps: 50.0` and `hours: 10.86` are wrong; at 30 fps it is **18.1 h**. Fig 6's corpus
panel prints that number. See [Known traps](#known-traps).

### File contents

Read out of `2022-10-07/10072022180149` (18,247 frames, 2 animals, 15 nodes):

| File | Datasets | Units |
|---|---|---|
| `points3d.h5` | `/tracks (F, 2, 15, 3)` f64 | mm, calibration frame |
| `aligned_points3d.h5` | `/tracks (F, 2, 15, 3)` f64 | mm, floor-aligned |
| `aligned_cage_points3d.h5` | `/tracks (1, 1, 24, 3)` f64 | mm, same frame as above |
| `reprojections.h5` | `/back … /topL`, each `(F, 2, 15, 2)` f64 | px, distorted |
| `*.proofread.slp.analysis.h5` | `/tracks (2, 2, 15, F)` — note the **transposed** layout — plus `/point_scores`, `/instance_scores`, `/track_occupancy`, `/node_names`, `/edge_inds` | px |

**PROVENANCE, read out of the files.** `sleap-anipose` made this 3D: its
`triangulate()` stamps `/tracks` with a `Description` attribute of exactly the form its
writer emits, and `reproject()` wrote `reprojections.h5`'s per-view datasets with the
matching descriptor. Two things follow that the filenames do not tell you:

- **It is a SIX-view solve.** The descriptor names the calibration camera order, and in
  **all 74 sessions** it is `back, backL, mid, midL, top, topL` — the two `side` views
  are excluded from the triangulation, even though `reprojections.h5` carries all eight
  and `aligned_cage_points3d.h5` was solved from all eight.
- **It is not a plain DLT.** sleap-anipose calls aniposelib's
  `CameraGroup.triangulate_optim`, an optimising triangulator whose defaults include a
  temporal-smoothing term. The options the run actually used (RANSAC, limb constraints,
  smoothing weight) are NOT recorded in the files, so they cannot be recovered from
  them.

Mouse-Dyad-10M's `*points3d_translated_rotated_metric.h5` carries no such descriptor — that
corpus's 3D comes from the recording lab's own pipeline, not from sleap-anipose.

`alignment.toml` holds `rotation`, `translation`, the 24 `original_points` (the cage
corners in the calibration frame) and `data_path`, which points at
`cage_data/<date>/<session>/cage_points3d.h5` — **a tree that is not on this
machine**. Use `aligned_cage_points3d.h5` instead; that is what
`blender-images/cage_scene.py` reads.

---

## Mouse-Dyad-10M — `/root/vast/eric/BMimica`

### Layout

```
BMimica/
├── <session>/                            <- 56, named YYYYMMDD_HHMMSS
│   ├── <ts>_points3d_translated_rotated_metric.h5   <- PROOFREAD 3D, METRES
│   ├── calibration/
│   │   ├── <ts>_calibration.toml         <- 5 cameras (absent in 6 sessions)
│   │   └── <ts>_calibration.metadata.h5
│   └── <serial>/                         <- 21241563, 21369048, 21372315,
│       │                                    21372316, 22085397
│       ├── <serial>-<ts>.mp4             <- the video, 1280x1024, 150.1 fps
│       ├── <serial>-<ts>.slp             <- SLEAP predictions
│       ├── <serial>-<ts>.analysis.h5     <- the 2D scripts actually read
│       └── calibration_images/
└── scratch/                              <- a SEPARATE re-triangulation, see below
```

One session is ~3.0 GB. The camera **serials are the camera names** everywhere in the
code (`SERIALS` in `luc3d-bench/scripts/bartul/build_gt_reproj.py`), in that order.

**Six sessions have an empty `calibration/`**: `20250908_152229`, `_154926`,
`_161812`, `_164528`, `_171240`, `_173928` — the whole 2025-09-08 day. Anything that
needs calibration either skips them or runs on an inherited rig; Fig 2 does the
latter and says so.

### File contents

Read out of `20250827_152238` (180,056 frames, 2 animals, 15 nodes):

| File | Datasets | Units |
|---|---|---|
| `*_points3d_translated_rotated_metric.h5` | `/tracks (F, 2, 15, 3)` f64, `/node_names`, `/track_names`, `/recording_frame_rate`, `/experimental_code` | **METRES**, floor-aligned, z = height, floor at exactly z = 0 |
| `<serial>-<ts>.analysis.h5` | `/tracks (2, 2, 15, F)` f64 (tracks, xy, nodes, frames), `/point_scores`, `/instance_scores`, `/tracking_scores`, `/track_occupancy`, `/node_names`, `/edge_inds`, `/video_path` | px, distorted |

The `.slp` files here have the same dead-video-path problem as SLAP-2M's: they embed
`F:/Jinrun/Data/<session>/video/<ts>/<serial>\<serial>-<ts>.mp4`, the acquisition
machine's Windows path. The `.mp4` sits next to the `.slp` on this machine, so the
poses come from the `.analysis.h5` and the video is opened by path, not through the
`.slp`.

**Units differ between the corpora**: Mouse-Dyad-10M 3D is metres (range ±0.33 on this
session), SLAP-2M 3D is millimetres. Every figure script multiplies Mouse-Dyad-10M by 1000
on load.

**No cage geometry exists for Mouse-Dyad-10M.** There is no `aligned_cage_points3d.h5`
equivalent, which is why Fig 1a draws a box fitted to the animals' own movement
footprint rather than a measured enclosure (`figs/fig1_bmimica_scene.py`).

### `BMimica/scratch/` — an independent DLT re-triangulation (40 GB)

Not the corpus and not LUC3D. A separate two-phase pass
(`scratch/scripts/triangulate_and_reproj.py`, `build_padded_h5s.py`) that
re-triangulates the per-camera SLEAP 2D with the calibration and reprojects it,
validating against the shipped proofread 3D:

- `scratch/triangulation_results/<session>_triangulated.h5` — `/pts_3d (F, 2, 15, 3)`,
  `/pts_2d/<serial>` and `/reproj/<serial>`, each `(F, 2, 15, 2)`, plus `n_frames` /
  `n_tracks` / `session` attributes.
- `scratch/data/<serial>_{inference,reproj}.h5` — `/tracks (47, F, 2, 15, 2)`, the
  47 sessions stacked and padded into SLAP-2M-shaped arrays.

---

## The 3D LUC3D itself produced

Distinguish three things that all look like "the 3D":

1. **The corpora's own proofread 3D** (above) — produced by the labs' pipelines, used
   throughout the paper as *reference*, not as LUC3D output.
2. **LUC3D's triangulations measured for the figures** — below.
3. **`BMimica/scratch/`** — a third-party DLT pass, neither of the above.

### Cross-view identity + 3D dumps (Mouse-Dyad-10M, all 56 sessions)

`/root/vast/eric/luc3d-bench/outputs/bmimica/results/`

| Path | What |
|---|---|
| `luc3d_dump3d/<session>.f64` | LUC3D's own per-identity 3D, raw float64 C-order matrix. Columns in the `.f64.json` sidecar: `frame, identityId, cx, cy, cz, nCams, nVisible, bodyLen, earDist, trunkX, trunkY, trunkZ`; e.g. 357,041 rows for `20250827_141755` |
| `luc3d_dump3d/<session>.json` | per-frame cross-view assignments (`'<serial>:<slot>' -> identity`), `framesProcessed`, `detections`, `runtimeSeconds`, `fps` |
| `luc3d_dump3d/<session>.truth.npz` | the reference the run was scored against |
| `luc3d_real/<session>.json` | the same run on real (non-GT) detections |
| `bytetrack/`, `bytetrack_noretire/`, `muppet/`, `liezl_c6/` | the baseline trackers, same shape |
| `muppet_reid/`, `muppet_sleap2/` | the two 3D-MuPPET STEELMAN arms added 2026-08-17 — see below |

Aggregates: `outputs/bmimica/bmimica_eval_per_session.csv`,
`bmimica_eval_aggregate.json`, `bmimica_crossview_all_eval.csv`,
`bmimica_crossview_all_aggregate.json`.

### The 3D-MuPPET steelman arms (2026-08-17)

The shipped 3D-MuPPET series (0.0112 within / 0.0112 cross) is a COVERAGE number, not
an identity score: its runner freezes the SORT-track-to-identity map at one init frame,
so each camera goes silent for good the first time a tracklet dies, and the absent
frames are scored as misses over the whole session (median coverage **1.31%**). Two
arms test that, both driven by `scripts/bartul/bmimica_muppet_reid.py`:

| Path | Arm | Input |
|---|---|---|
| `results/muppet_reid/<session>.json` | `muppet_run_reid.py` — re-runs MuPPET's own cross-view matching whenever a camera has an unlinked live SORT track | the 4-slot shared pool, `det_h5/` |
| `results/muppet_sleap2/<session>.json` | `muppet_run.py`, the faithful port, unchanged | `sleap_h5/`, i.e. SLEAP forced to 2 tracks |

`sleap_h5/<session>/<serial>_predictions.h5` (`/tracks (1, F, 2, 15, 2)`) is
therefore BOTH a baseline's own output and an input to another tracker — and note it is
the 2-track truncation that made it invalid as a SLEAP *baseline*.

**A result JSON's assignment keys are `"<serial>:<slot>"`, where `slot` indexes the
array the tracker RAN on**, so scoring `muppet_sleap2` against the 4-slot pool would
silently compare different boxes. `figs/fig7_muppet_reid.py` carries the detection
source per arm for exactly that reason, and gates the port arm against the shipped
numbers before reporting anything. Its deposit is `figs/out/fig7_muppet_reid.json`
(+ `.csv`).

### Triangulation-solver inputs and errors (Fig 2, Fig 4)

- `figs/out/fig4_input.json` + **`figs/out/fig4_input.bin`** (1.77 GB) — the real
  observations Fig 4's solvers ran on: per keypoint, the raw distorted 2D in each of
  the 5 cameras plus the reference 3D in the calibration frame, with each session's
  `mm_per_unit`. Written by `figs/fig4_export.py`; stride 15 over the 50 proofread
  sessions. `fig4_input.stride60.bin` is the coarser earlier pass.
- `figs/out/fig4.json`, `fig4_by_views.json`, `fig4_anipose.json`,
  `fig4_move_geometry.json` — DLT vs non-linear refinement vs aniposelib, in-sample
  and leave-one-camera-out, per session.
- `figs/out/fig2.json`, `fig2-protocol.json` — the two-anchor protocol measurement:
  how often a reprojection lands inside tolerance, per session.

### Saved LUC3D projects (SLP 2.8, 3D inside `/session_data`)

Written by the app itself, so these are the only artefacts in the whole map that
carry LUC3D's 3D *in LUC3D's own format*:

| Path | Size | What |
|---|---|---|
| `_real-roundtrip-1225929.slp` | 1.40 GB | the real 180,210-frame × 5-camera project, Track All + Triangulate All + save |
| `_real-roundtrip-1443936.slp`, `…-resave.slp` | 1.40 GB each | reopen → modify → save cycle (the #185/#189/#190/#191/#193 OOM work) |
| `_bugdata/20260317_120212-03_17_2026_cage5/test_save.slp` | 1.01 GB | the cage5 project |

All are in the repo root / `_bugdata`, untracked. `_bugdata/` also holds the raw
sessions the app is driven against (`20260605_133431-HardFight`, `…_reencoded`,
the three `cage5` variants, each with `calibration.toml`).

### Trimmed sessions committed for the figures

- `figs/session/` — the 8-camera HardFight session cut to a 300-frame window
  (`Camera0_mid` … `Camera7_sideR`, each `<cam>.mp4` + `<cam>.slp`, plus
  `calibration.toml`). Built by `figs/build_fig_session.py`.
- `figs/session-slap-10072022145420/` — the same treatment for a SLAP-2M session
  (`back`, `backL`, `mid`, `midL`, `top`, `topL` + `calibration.toml`).

---

## Reprojections — four different things

| Which | Where | Made by |
|---|---|---|
| SLAP-2M, shipped | `<session>/reprojections.h5` (all 8 views in one file) and per-camera `*.reprojections.slp[.h5]` | the SLAP pipeline |
| Mouse-Dyad-10M, as 2D ground truth | `luc3d-bench/outputs/bmimica/gt/<session>/<serial>/proofread.analysis.h5` — `/tracks (2, 2, 15, F)`, `/track_occupancy` | `luc3d-bench/scripts/bartul/build_gt_reproj.py`: proofread 3D → calibration frame by RANSAC-Procrustes → project → distort |
| Mouse-Dyad-10M, independent pass | `BMimica/scratch/triangulation_results/<session>_triangulated.h5` `/reproj/<serial>`; padded twins in `scratch/data/<serial>_reproj.h5` | `BMimica/scratch/scripts/triangulate_and_reproj.py` |
| In the app, live | not stored — computed per frame by `pose/triangulation.js`; the *measurement* of it is `figs/out/fig2.json` | LUC3D |

`build_gt_reproj.py` is also the shared library the figure scripts import for
`load_calibration`, `load_sleap_2d`, `ransac_align`, `undistort` and `SERIALS`.

## Detections used for tracker benchmarks

- Mouse-Dyad-10M: `luc3d-bench/outputs/bmimica/det_h5/<session>/<serial>_predictions.h5`
  — `/tracks (1, F, 4, 15, 2)`, i.e. up to 4 detection slots per frame per view.
- Mouse-Dyad-10M retracked: `outputs/bmimica/retracked/`, `retracked_max2/`, `retracked_max2b/`
  — `<session>/<serial>.slp`, ~150 MB each.
- SLAP-2M: `outputs/predictions_h5s/<view>_predictions.h5`, plus
  `keepall_h5s/`, `keeptrack_h5s/`, `sleap_nn_predictions_h5s/`, `detections_only_h5s/`.

## Machine-readable indexes

Prefer these over globbing the trees:

| Index | Rows | Notes |
|---|---|---|
| `/root/talmolab-smb/eric/slap_2m/master_sheet.xlsx` | 74 | the corpus definition; `session`, `session_path`, animal counts by coat colour, `obstacle_rating`, `bedding`, `frames`, `duration` (**minutes**), `difficulty` |
| `luc3d-bench/outputs/predictions_master_sheet.tsv` | 74 | the sheet resolved to files: per view `*_inference_h5`, `*_reproj_h5`, `*_video`, `*_raw_pred_slp`, `*_proofread_h5` (51 columns) |
| `luc3d-bench/outputs/bmimica/bmimica_master.tsv` | 50 | Mouse-Dyad-10M equivalent: `calibration_toml` plus per-serial `raw_pred_slp` / `proofread_h5` |
| `figs/out/fig6.json` | 56 + 74 | the survey the paper's corpus numbers come from: per session cameras, frames, animals, nodes, fps, `has_calibration`, `has_proofread_3d`, `nan_frac`; plus `rigs`, `skeleton`, `corpora` totals |

---

## Frames of reference

The single most common way to get a wrong answer here. Three frames are in play:

1. **Calibration frame** — what `calibration.toml` extrinsics are in. Mouse-Dyad-10M: mm,
   origin at camera 0. This is the only frame you can project to pixels from.
2. **P-frame** (Mouse-Dyad-10M `*_translated_rotated_metric.h5`) — metres, floor-aligned,
   z = height, floor at exactly 0. Related to the calibration frame by a
   *similarity* transform (scale ≈ 1.005 mm per unit) that is **not stored anywhere**
   and must be re-fitted.
3. **Aligned frame** (SLAP-2M `aligned_points3d.h5`) — mm, floor-aligned via
   `alignment.toml`, which *is* stored.

The Mouse-Dyad-10M fit: triangulate the raw per-camera 2D with the calibration, then
RANSAC-Procrustes the P-frame points onto that cloud (`ransac_align`). On
`20250827_152238` it converges at 98.3 % inliers and 1.32 mm median residual. Fig 1,
Fig 2, Fig 4 and Fig 5 all use this one recipe and deposit the fitted scale, inlier
fraction and residual so it is checkable — `figs/fig5_views.py` and
`figs/fig1_bmimica_scene.py` are the reference implementations. **Do not fit a second
one**; two differently-wrong alignments put two figures' cameras in different places.

Skeleton, both corpora (15 nodes, 14 edges, from `slap_2m/mouse_skeleton.toml`):
`Nose, Ear_R, Ear_L, TTI, TailTip, Head, Trunk, Tail_0, Tail_1, Tail_2,
Shoulder_left, Shoulder_right, Haunch_left, Haunch_right, Neck`.

---

## Derived layer

The figures never read raw data at draw time. Everything lands in `figs/out/` first:

- `figs/out/*.json` — one deposit per measurement pass; `*.bin` / `*.f64` alongside
  where the payload is too big for JSON.
- `figs/data/fig<N>/*.csv` — 82 CSVs, the plotted numbers, one per panel.
- **`figs/PANEL-SOURCES.md`** — generated: every panel → the script that drew it, the
  deposit it read, the pass that produced that deposit, the CSV it wrote. Start here
  when tracing a number on the artwork back to disk.

## Environments

| Env | Use |
|---|---|
| `/root/vast/eric/luc3d-bench/lp3d_env/bin/python` | anything needing `cv2` / `toml` / `scipy` — calibration, triangulation, alignment |
| `figs/.venv/bin/python` | panels and documents (matplotlib, PyMuPDF) |
| `figs/blender-images/bpyenv/bin/python` | the Blender renders |
| `/root/vast/eric/luc3d-bench/liezl_env`, `anipose_env`, `eks_env`, `sleap_nn_env` | the baseline trackers and solvers |

## Known traps

- **SLAP-2M is 30 fps, not 50.** `fig6_measure.py`'s hard-coded `default_fps=50.0`
  reaches `fig6.json` and Fig 6's corpus panel, which prints `10.9 @50 fps` where the
  data says **18.1 h @30 fps**. Three independent sources agree on 30: the mp4
  container, `master_sheet.xlsx`'s `frames / duration`, and RESULTS.md's own
  "11 frames at 30 fps". Not yet fixed.
- **Every `.slp` in both corpora embeds a dead absolute video path** — a CI runner's,
  a Windows `G:` Drive mount, or `F:/Jinrun/Data/…`. Only SLAP-2M's
  `*.static.externals.slp` carries a relative path. Read poses from the
  `.analysis.h5` twins and open videos by path.
- The `CRF30` in every SLAP-2M `.slp` filename is a stale label — the embedded
  reference and the file on disk are both CRF12.
- **84 SLAP-2M session directories, 74-session corpus.** Read the sheet.
- **6 Mouse-Dyad-10M sessions have no calibration** (all of 2025-09-08).
- **Mouse-Dyad-10M 3D is metres, SLAP-2M 3D is millimetres.**
- **`alignment.toml`'s `data_path` points off this machine** (`cage_data/…`); use
  `aligned_cage_points3d.h5`.
- **Analysis HDF5 `/tracks` is `(tracks, xy, nodes, frames)`** — frames LAST, unlike
  every 3D file here, which is frames FIRST.
- **No cage geometry for Mouse-Dyad-10M**, so Fig 1a's box is a movement footprint and must
  never be captioned as an enclosure.

## Not covered here

The s-DANNCE transfer benchmark is a third corpus:
`/root/vast/eric/s-DANNCE-data/` (`s-DANNCE-{TRIADS,BEDDING,LONG-EVANS,SCN2A_SOC1,
SOC2,SOC3}`, plus `sDANNCE_file_info.xlsx` and `README.txt`), with the benchmark's
own outputs under `figs/fig10-bench/results/` and `figs/s-dannce-bench/`. Its
provenance is documented in `figs/s-dannce-bench/LEGEND-fig10.md`.
