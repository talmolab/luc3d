# B series: every displayed 3D from LUC3D v1.0.5 or the dataset (2026-10-20)

Eric: "make the b series the completely luc3d generated ones and not use any numpy
triangulation ... otherwise it is false advertising." We supply the code, so every 3D
pose, identity or camera placement a b-series figure shows must be either (a) the
dataset's own 3D as shipped, or (b) computed by LUC3D v1.0.5 (2dc001fe, clean
`/root/vast/eric/lucid-main-md56`). Never a Python/NumPy triangulation.

Status: **DONE** (2026-10-20 ~21:30 UTC, eric-mimicc-0-1). The b series is built and checked. It is not promoted and nothing is committed; both wait on Eric.

## 1. Audit: what the placed figures showed before this pass

| Panel | Placed render / PDF before | 3D source before | Verdict |
|---|---|---|---|
| Fig 3D idswitch | `fig3d_idswitch.pdf` 10-20 03:27, render 08-25 | NumPy DLT + Python association (`hardfight_common.py`, old) | NumPy, must redo |
| Fig 1D pose + rig | `fig1d_pose.png`, `fig1d_rig.png` 08-25 | poses: app export on the August working tree; floor alignment + arena: NumPy DLT cloud | NumPy alignment, must redo |
| Fig 2A 3D tile | `fig2a_pose.png` 08-25 | same as Fig 1D | NumPy alignment, must redo |
| Fig 1A Mouse-Dyad tile | `mouse-dyad_f55701.png` 08-19 | dataset 3D; camera placement fitted with NumPy DLT | NumPy cameras, must redo |
| Fig 5A 3D tile | `fig5a_upright.png` 08-21 | dataset 3D; alignment from NumPy-aligned `fig5_views.json` | NumPy alignment, must redo |
| Fig 2B-G, 2D camera strip | rebuilt 10-20 15:04 | LUC3D v1.0.5 deposits | OK |
| Fig 3C (SLAP-2M), Fig 6E, Fig 5B-G | - | dataset 3D / dataset reprojections | OK (dataset) |

Why it would have slipped through: `src/style.py:tagged_render()` silently falls back
to the base (August) render when `<name>_b.png` is missing unless
`FIG_RENDER_REQUIRE=1`; `fig1d_scene.py` / `bmimica_scene.py` default to the untagged
scene JSONs.

## 2. Code: NumPy triangulation removed from the b-series dependency path

- `blender-images/hardfight_common.py`: NumPy DLT, worst-view rejection and the
  Python cross-view matcher deleted. Reads `out/hardfight_luc3d.npz` (LUC3D v1.0.5
  tracker + DLT over all 36,000 HardFight frames, `figs/hardfight_luc3d.py`), refuses
  any other commit. 2D overlays via LUC3D `reprojectPoint` (`lucid_geom.mjs`).
- `fig5_views.py`, `fig1_bmimica_scene.py`: alignment triangulation via
  `lucid_geom` (LUC3D `Camera.undistortPoint` + `triangulatePointDLT`); deposits
  `out/fig5_views_js.json`, `out/fig1_bmimica_scene_b.json` stamped 2dc001fe.
- Remaining Python geometry in the path, all allowed (not triangulation):
  `hardfight_common.py` PCA of LUC3D's keypoint cloud for the render floor;
  `idswitch_fig_style.py` label placement in the Blender camera;
  `hyp_fig_prep.py` / `chen_common.py` undistorting SLAP-2M's shipped reprojections
  (dataset).

The two HardFight scene scripts recorded a hard-coded
`"alignment": "blender-images/renders/hardfight_alignment.json"` (the base, NumPy-fitted
file) even when they had used the `_b` cache. They now record
`os.path.relpath(hf.ALIGNMENT_CACHE, HERE)`. The `_b` alignment (fitted to LUC3D's
cloud) differs from the base by 0.3 mm in translation.

## 3. App pose exports on v1.0.5

Fig 1D and Fig 2A draw the app's own reconstruction (`fig1d_pose.json`,
`fig2a_pose.json`). Those had been exported in August from the **eric/figs working
tree** (`_drive.mjs` served `figs/..`), not v1.0.5. Not NumPy, but not the version
under test.

- `_drive.mjs`: new `LUCID_APP_ROOT` (directory to serve) and `FIG_OUT_DIR` (where
  shots and manifests go). Under `LUCID_APP_ROOT` it asserts, via `lucid_v105.mjs`,
  that the served `pose/` is the clean 2dc001fe checkout `POSE_DIR` names, stamps every
  manifest (`lucid_root`, `lucid_commit`, `pose_dir`, `served_app_root`, `driver`), and
  refuses to reuse an already-running server (which would serve some other root).
- Serve root: scratch dir of symlinks to every top-level entry of
  `/root/vast/eric/lucid-main-md56` plus `figs/session` (the checkout stays clean).
- Headless Chromium lacked 12 libs on this host (nss, nspr, atk, X ext, alsa); installed
  into a scratch conda prefix (`chromelibs`), used via `LD_LIBRARY_PATH` only.
- `node fig1d_pose_export.mjs` → `out/b_app/fig1d_pose.json`: 3 identities, 900
  groups, 15/15 nodes × 8 cameras. vs the August export: max |Δ| 0.10 / 0.06 / 1.01 mm.
- `node fig2_protocol.mjs` → `out/b_app/fig2a_pose.json`, `fig2-protocol.json` and the
  Fig 2A tiles `fig2p-*.png` (v1.0.5 captures). Two-anchor pose vs August: max |Δ|
  18.0 / 5.7 / 18.0 mm; the reprojection summary (2-anchor [4.34, 3.47, 11.07] px vs
  all-views [3.27, 3.19, 12.05] px) is unchanged. Log `out/md56_logs/B_v105_fig2_protocol.log`.
- `fig1_hardfight_scene.py` / `fig2a_scene.py` rerun (`FIG_TAG=b`, `--pose out/b_app/...`)
  → `out/fig1_hardfight_scene_b.json`, `out/fig2a_scene_b.json`. Frame-offset check:
  v1.0.5 app vs the full-session LUC3D run, **0.0 / 0.0 / 0.0 mm** median per animal.
  Arena 493.8 × 321.3 mm, viewpoint azim 282.7°, elev 19.4°.

### 3b. Fig 1 app captures on v1.0.5

`fig1_tracking.mjs` (only `_drive.mjs` writes, so `FIG_OUT_DIR` holds) reshot into
`out/b_app/`: `before-*` / `after-*` tiles, `tri3d-*`, `fig1.json` (stamped 2dc001fe,
`served_app_root` = the v1.0.5 serve root). Log `out/md56_logs/B_v105_fig1_tracking.log`.
Against the August capture, `tracked`, `triangulated`, `stats`, `ledger`,
`distinctTrackLabels` and `timelines` are all **identical** (frame 198: 25 detections ->
3 identities, 24 assigned, 900/900 groups with 3D). The main `out/after-*` files are unchanged.

## 4. Renders (`_b`)

`out/md56_logs/run_B_luc3d_renders.sh` -> log `out/md56_logs/B_luc3d_renders.log` (20:52-20:53 UTC,
Cycles/OptiX on the A40). All seven `_b` renders written, and the end-of-run hash check printed
OK for all 10 main inputs. Every one was compared with its base:

| Render | vs base | Why |
|---|---|---|
| `idswitch_render_hardfight_b`, `lucid_idswitch_style_hardfight_b` (Fig 3D) | **changed** | LUC3D's identities. The pair is still the closest pair at frame 21144, but following each animal by its LUC3D identity rather than the old nearest-centroid re-linking makes the OTHER animal the farther traveller, so A/B (blue/orange) trade places, and one post-contact trail now ends at frame 21244, not 21736 (the old Python matcher and LUC3D's tracker disagree on who is who after the contact). |
| `fig1d_pose_b`, `fig1d_rig_b` (tex Fig 1C) | same to the eye (mean abs px diff 2.0 / 0.8) | the v1.0.5 app pose is within 1 mm of August; the floor alignment moved 0.3 mm |
| `fig2a_pose_b` (Fig 2A) | **changed** (5.7) | the v1.0.5 two-anchor solve moves keypoints by up to 18 mm (blue animal's posture visibly different) |
| `fig5a_upright_b` (Fig 5A) | identical (0.0006) | dataset pose; only the alignment moved to LUC3D |
| `mouse-dyad_f55701_b` (tex Fig 1D right) | identical (0.17) | dataset pose; camera placement now aligned on LUC3D's DLT (cameras move <= 0.02 mm) |

Fix needed on the way: `idswitch_fig_style.py` relied on a system Liberation Sans. This host has
none, so it fell back to DejaVu Sans and clipped the legend. It now registers the bundled
`src/fonts/*.ttf` exactly as `src/style.py` does (no change on a host that has the font).
(A downscaled montage briefly suggested the Mouse-Dyad backdrop had gone white. Pixel values
show both renders have the identical grey gradient, so that was an artefact of the montage.)

## 5. Figure build

`out/md56_logs/run_B_luc3d_build.sh` -> `out/md56_logs/run_B_luc3d_build.out`, logs `B_fig{1,2,3,5}.log`,
loads `B_loads.tsv`, links `B_links.tsv`.

- Inputs: `FIG_VARIANT=b`, a link set of 37 `out/*_b.json` = x7's 30 links (what the main
  figures were built from) + 7 overrides, ALL required (`FIG_VARIANT_REQUIRE`): the two `_b`
  HardFight scene JSONs, `fig1.json` / `fig2-protocol.json` -> `out/b_app/`, and the three J17
  timing deposits. `FIG_RENDER_REQUIRE=1`, `FIG_APP_OUT=out/b_app` (new, `src/data_loader.APP_OUT`;
  used only by the app-tile reads in `panels/fig1_02`, `fig1_03`, `fig2_01`), x7's env plus
  `FIG3F_CLEAN_TAG=_j17`.
- **fig1b 5/5, fig2b 11/11, fig3b 11/11, fig5b 7/7 panels, 0 failed.** Output
  `figures/fig{1,2,3,5}b/`, `data/fig{1,2,3,5}b/`.
- Every render resolved to its `_b` file (6/6, no `BASE used`). Every deposit load came
  through a b link (0 exceptions).
- CSV diff against the main `data/fig{1,2,3,5}`: **one file**, `fig3e_head_to_head.csv`, which
  is the J17 timing (2x5 greedy 0.238 -> 0.282 ms, exhaustive 4.00 -> 3.95 ms, 3x5 887 -> 873 ms,
  4x6 greedy 0.653 -> 0.703 ms). These are the numbers the tex already quotes (14x, 0.28 to
  0.70 ms). Everything else, including all of Fig 2B-G and Fig 3E-H, is byte-identical.
- **Found in the main series:** the placed `figures/fig3` Fig 3F still carries the T1 timing
  (0.238 ms), while the tex quotes J17. The c Fig 3 was promoted at 15:44, before the J17
  rebuild landed (16:55). The b Fig 3 fixes this.
- Looked at all four assembled PNGs. Fig 3D shows LUC3D's reconstruction with the drawn swap,
  Fig 2A's tiles are the v1.0.5 captures, and nothing is clipped or missing.

## 5b. Static scan (plan G2) over the b build's path

Scanned every panel of Figs 1/2/3/5, `assemble.py`, `fig3_sync.py`, `src/`, the scene preps
(`fig1_hardfight_scene`, `fig2a_scene`, `fig1_bmimica_scene`, `fig5_views`, `hardfight_luc3d`) and
every Blender script on the path, for `triangulate_batch|def triangulate|np.linalg.svd|cv2.triangulatePoints|cv2.projectPoints|cv2.undistortPoints|cv2.undistort(|fig2_measure|.project(|undistort_px`.
**No hit triangulates, associates or reprojects anything presented as LUC3D.** Every hit:

| Hit | Classification |
|---|---|
| `lucid_geom.py` `triangulate`/`project`/`project_pinhole`, `fig5_views.py` `lucid_geom.project`, `hardfight_common.project_pinhole` | calls into LUC3D v1.0.5 JS (`lucid_geom.mjs`) |
| `hardfight_common.py:222` SVD | floor-plane PCA of LUC3D's keypoint cloud (render scene geometry) |
| `cage_scene.py:357,415` SVD | plane fits to the dataset's cage points (SLAP-2M scene) |
| `hyp_fig_prep.py` `cv2.undistort`, `undistort_px` | undistorting photos and the dataset's shipped reprojections (Fig 3C, dataset); `exact_plane_point` lays pixels onto the display quad of a distortion-free camera copy |
| `chen_common.project`/`undistort_px` | used only by the SLAP-2M dataset path above; the HardFight path hands it LUC3D's pixels with zero distortion |
| `idswitch_fig_style.py` `stg.project` | Blender staging camera, label placement |
| `panels/fig5_05:24`, `src/data_loader.py:11` | docstrings |

## 6. Tex changes

Backup `out/md56_logs/luc3d_newest.before_B_luc3d_2026-10-20.tex`.
- Fig 3D caption: "Its 3D poses were reconstructed offline for this figure rather than by
  LUC3D, and the swap is drawn rather than taken from a tracking run." -> "Its 3D poses and
  identities are LUC3D's reconstruction of the HardFight recording, and only the exchanged
  identities in the top camera are drawn rather than taken from a tracking run."
- Blender Methods, one sentence added: the renders in Figures 1D, 3C, 4A and 5A show each
  dataset's own 3D poses as shipped, and those in 1C, 2A and 3D show LUC3D's reconstruction.
  (Tex lettering: 1C = HardFight triangulated 3D, 1D = the two arenas.)
- No other number moved: the only changed CSV is the J17 timing the tex already quotes, and
  Fig 2A's reprojection summary is not quoted.
- **These two sentences describe the b figures.** The tex still places `figs/figN.pdf` (main),
  whose Fig 3D is still the offline version. So promote b, or revert the two sentences from
  the backup.

## 7. Open items (for Eric)

1. **Promote b?** `figures/fig{1,2,3,5}b` -> main (as `run_PROMOTE_x7.sh` did). Until then the
   tex's Fig 3D caption and Blender sentence do not match the placed Fig 3. Main Fig 3F's
   T1-vs-J17 mismatch is also fixed only by promoting.
2. Fig 1: the tex places a static `figs/fig1.pdf`, not `figures/fig1/fig1.pdf`. `figures/fig1b/fig1b.pdf`
   is the LUC3D-only build. Its panel letters (a arenas, c re-ID, d 3D) differ from the tex's
   (A re-ID, C 3D, D arenas), so the static file needs re-laying out, or the tex caption's letters do.
3. Fig 3D now shows a different animal as "Animal 1" (blue), because the identities are LUC3D's.
   The caption needs no change.
4. Cleanup not done (no figure reads it): `fig2_measure.py` (NumPy DLT) and its two users
   `j3_alignment_check.py` and `fig4_idf1_3d.py` are still outside `legacy/`;
   `fig4_detections.py`'s opt-in `FIG4_PY_TRIAGE` path still imports it.
5. `out/md56_logs/run_B_numpyfree.sh` is superseded (built from the August app poses). Do not
   run it; it refuses anyway because `_b` files exist. Its first partial outputs are kept in
   `out/md56_logs/b_series_first_outputs_2026-10-20/`.
6. Nothing committed. The working tree carries the code changes (sections 2, 3, 4 and 5).

## 8. 2026-10-21: Figs 4, 6, 7 added; the b series is complete (1 to 7)

- `fig4_detections.py` part B (NumPy DLT + OpenCV triage) **deleted**. Its only users were unplotted
  fields. The Fig 4C deposit was regenerated without it (`out/fig6_detections_proofread_notail_nopy.json`).
  Its per-session, by-difficulty and by-animals data are identical to the August file. The raw
  `fig6_detections.json` (the other Fig 4 detection panels) regenerates slightly differently, so it
  stays the August file as placed (Eric: no need to chase). It still carries the old, unplotted
  NumPy triage fields.
- `out/md56_logs/run_B_luc3d_build_467.sh`: fig4b 7/7, fig6b 11/11, fig7b 7/7 panels, 0 failed.
  Same b link set and env as Figs 1/2/3/5.
- Two bugs found and fixed:
  - `panels/fig4_11_idf1_by_difficulty.py` followed the variant only for md56/x7, so a b build
    silently read the pre-v1.0.5 `fig9_slap2m_lite_bvis5_notailscore.json` (Oct 8). With `b`
    added, fig4b is identical to main.
  - `panels/fig6_07_pr_switches.py` wrote the MAIN `figures/fig6/fig6f_axes.json` on every
    tagged build (x7, c and b all overwrote it). Restored from git, and it now writes only when
    untagged. It was also missing `import os`.
- b vs main data: identical everywhere except Fig 3F timing (b = J17, as the tex quotes; main is
  stale T1) and Supp 6H (b = v1.0.5 s-DANNCE run; 6H is neither placed nor quoted).
- Stamps: `fig1_hardfight_scene_b` / `fig2a_scene_b` now carry the v1.0.5 stamp (data
  unchanged). `fig3_headtohead_clean_b3_j17.json` was stamped as J12 did (metadata only, backup
  `out/md56_logs/j17_hh_backup_2026-10-21/`). The manifest classifies every b input, and
  `provenance_gate.py` now also scans the Blender/render prep scripts (`render_path_scripts`).
  The gate still FAILS on pre-existing commit-stamp gaps that are not NumPy: fig3_runtime_b3,
  md56main fig3_quality, fig9_slap2m_lite (4D), stale_sweep_slap2m (6F), s-DANNCE agg (6G), and
  two unclassified Fig 4 deposits.

## 9. Tex vs b data (four read-only audits, 2026-10-21)

About 230 numbers checked against `data/fig{1..7}b` and the b deposits. Mismatches:
- L269 "all from one run of the application's own solvers": Fig 2B-G come from four driver runs,
  and 2F/2G include Anipose.
- L301 "more than 100 times slower": the b deposit gives 82x (2346.8 vs 28.5 us/keypoint).
- L409 "0.993 for SLEAP and 0.988 for ByteTrack": the panel plots medians of 0.992 / 0.987 (LUC3D
  0.995 OK). The tex took a stale summary key. Same in main.
- L285 (Fig 3 timing Methods):
  - "1,000 per session": two 2x6 sessions had fewer, so "up to 1,000".
  - "roughly doubles": the data suggest about 3x, and indirectly only.
  - "No other process of ours ran": the J17 watcher saw editor/Claude activity up to 0.58 core
    and marked the sitting valid=false.
  - The 4x6 bar's two ends use different per-hypothesis rates (83.9 vs 111 us).

Numbers with no source in the repo data (not wrong, unverifiable here):
- the SLAP-2M corpus counts (74 sessions / 15.6 M frames / 1-4 mice) and Mouse-Dyad 50.4 M frames
- ~20 M 3D / ~100 M 2D instances
- the in-browser 16,030 / 14,694 fps
- "18 pairings" (the b data hold 17 in the 37 display sessions)
- several calibration-Methods numbers (882/378 frames, "about 0.1 px", "three of six draws",
  9,029 / 12,621 frames)
