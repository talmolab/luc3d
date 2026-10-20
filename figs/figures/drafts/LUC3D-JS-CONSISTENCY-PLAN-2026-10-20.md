# LUC3D JavaScript consistency plan, 2026-10-20

This paper is a test of **LUC3D v1.0.5**, the JavaScript application. Every panel and every number that the paper attributes to LUC3D must come from running that JavaScript. A Python copy of what LUC3D does is not LUC3D, however close its numbers are.

This plan sits on top of `CONSISTENCY-PLAN-2026-10-19.md`. Its rules 1 to 9 (same sessions, pools, tail handling, exact data match, timing) still hold. This plan adds the rule below, the checks that enforce it, and the work to fix what breaks it.

Two hosts work from it: **eric-mimicc-0-1** (handoff `HANDOFF-ericmimicc-JS-2026-10-20.md`) and **eric-mimic2-0-6** (handoff `HANDOFF-ericmimic2-JS-2026-10-20.md`). Log every step at the bottom with the host name and UTC time.

Status values: `todo`, `running`, `done`, `decision` (waiting on Eric).

## How this happened

`figs/fig2_measure.py` (2026-08-05, written in a Claude session) measured Fig 2 with its own NumPy DLT. Its docstring described the result as what "LUC3D draws". When Fig 2C later needed LUC3D's refinement, a session wrote `fig2_solvers_by_views.mjs` to run the real app code, but 2B and 2D were never moved over. The same NumPy DLT was imported into `fig5_views.py` (Fig 5A), and a second copy sits in `blender-images/hardfight_common.py` (Fig 3D). No audit ever asked which code computed a number, only whether the numbers matched. On 2026-10-20 a session even wrote the NumPy DLT into Methods as if it were fine. Eric caught it.

## The rule

**R1. LUC3D numbers come from LUC3D's JavaScript at v1.0.5.** Commit `2dc001fe527c4dbaad17fa171da132cfdfe010e6`, checked out clean at `/root/vast/eric/lucid-main-md56`. Node drivers import its modules through `POSE_DIR=/root/vast/eric/lucid-main-md56/pose` or `LUCID_ROOT=/root/vast/eric/lucid-main-md56`. App captures serve that checkout. Never the `eric/figs` working tree's `pose/`, never `figs/fig6-bench/xv_experimental.js`, never a default path inside a script.

**R2. What Python may do.**

| Allowed in Python | Not allowed in Python |
|---|---|
| Scoring LUC3D's outputs (motmetrics IDF1, error statistics, medians, tests) | Triangulating a point that a figure presents as LUC3D's |
| Plotting and assembling | Reprojecting a LUC3D 3D point into a camera |
| Baselines run with their own code (aniposelib, SLEAP, ByteTrack, the exhaustive baseline) | Undistorting points for a LUC3D solve |
| Reading the datasets' own reference 3D, presented as the dataset | Tracking, grouping or assigning identities for LUC3D |
| Calibration scoring with aniposelib (declared scorer) | Dropping outlier views on LUC3D's behalf |

When a figure needs any right-hand-column step, it calls LUC3D's JavaScript (`pose/triangulation.js`, `pose/triangulation-core.js`, `pose/tracker.js`, `pose/cross-view-tracker.js`, the `Camera` class) from the v1.0.5 checkout.

**R3. Illustrations count.** A rendered or drawn panel that shows LUC3D's 3D poses, tracks or identity assignments must be made from LUC3D output. A panel that shows the dataset's reference 3D must say so. A schematic with no data in it is fine.

**R4. Every LUC3D deposit is stamped.** Each new or rewritten deposit records `lucid_root`, `lucid_commit` (read with `git -C <root> rev-parse HEAD` at run time, and the checkout must be clean), `driver` (the script that called LUC3D) and `generated_by`. A script refuses to run if the commit is not `2dc001fe` or the checkout is dirty, as `fig3f_timing_clean.py:128-133` and `run_SDV105.sh:26-31` already do.

**R5. Text matches code.** Methods describes what the figure's code did. If a panel uses a protocol that is not an app feature, Methods says it is an analysis protocol. Never describe a reimplementation as LUC3D, and never describe a driver's own rule as the app's feature.

## Enforcement

**G1. Provenance gate (`figs/provenance_gate.py`, new, owner eric-mimicc).** It runs after the final build and reads the build's `FIG_VARIANT_LOG`. It classifies every deposit through a committed manifest `figs/provenance_manifest.json` (deposit name to kind: `luc3d_js`, `dataset`, `baseline`, `scorer`, `calibrat3`, `illustration`, with a one-line reason). The gate fails if:
- a deposit read by the build is not in the manifest;
- a `luc3d_js` deposit lacks `lucid_commit` = `2dc001fe…` or its `lucid_root` / `pose_dir` is not the v1.0.5 checkout;
- `fig2.json` (the NumPy DLT deposit) is read by any placed panel;
- a Blender or illustration input that shows LUC3D output was made by a script on the R2 "not allowed" side.

**G2. Static scan (part of G1).** The gate greps every script in the final build's dependency path (panel scripts, deposit generators, Blender prep scripts) for `triangulate_batch`, `def triangulate`, `np.linalg.svd`, `cv2.triangulatePoints`, `cv2.projectPoints` and `cv2.undistortPoints`. Every hit must be in the manifest's `python_geometry_allowlist` with its reason (baseline, scorer, calibration, scene geometry for a dataset render). Any other hit fails the gate. As of 2026-10-20 the hits outside `legacy/` are:

| Script | What it is | Expected outcome |
|---|---|---|
| `fig2_measure.py` | NumPy DLT behind 2B / 2D | retired (J2) |
| `fig5_views.py` | NumPy DLT + cv2 behind Fig 5A, Fig 2D camera strip, Fig 1 / 5a renders | ported to JS (J4) |
| `blender-images/hardfight_common.py` | NumPy DLT + Python association behind Fig 3D, Fig 1C / 2A arena | ported to JS (J5) |
| `fig2_solvers_export.py` | NumPy DLT aligning the reference 3D into the calibration frame, sets `mm_per_unit` for 2C / E / F | ported to JS, transform asserted unchanged (J3) |
| `fig4_detections.py` | NumPy DLT "triage" fields in the Fig 4C deposit, not plotted | removed or ported (J9) |
| `fig1_bmimica_scene.py`, `blender-images/cage_scene.py`, `blender-images/slap2m_movie.py` | scene geometry for dataset renders | classify (J10) |
| `fig4_idf1_3d.py`, `fig4_pose.py` | unknown whether any placed panel uses them | classify (J10) |
| `fig2_solvers_anipose.py`, `fig7_calib_anipose_on_ours.py`, `fig7_calib_gt_compare.py`, `out/md56_logs/calib_b/make_synthetic_session_b.py` | Anipose baseline, calibration scoring, synthetic rig | allowlist with reason |
| `panels/fig5_05_upright_views.py` | check what it projects | classify (J4) |

**G3. Tex check.** Before the final compile, grep Methods for every sentence that says how a LUC3D number was computed ("the application", "LUC3D", "triangulat", "reproject", "drop") and check each against the generator named in the manifest.

## Audit findings, 2026-10-20

From the three read-only audits (details in the old plan, rows J1a to J1c).

**Already LUC3D v1.0.5 JavaScript (no work):** Fig 2C, 2E top, 2F, 2G (solver timing via `POSE_DIR`). Fig 3E to H, the camera-subset run, Fig 4D, all of Supp Fig 6 (A to D, F staleness on both datasets, G s-DANNCE). The exhaustive baseline reuses v1.0.5 `pose/triangulation.js`.

**Not LUC3D's JavaScript (work):** Fig 2B measured curve, Fig 2D, the Methods 0.13% check, Fig 2E bottom drop rule, Fig 5A, Fig 3D, the reference alignment in the Fig 2 export.

**Eric, 2026-10-20:** Fig 5 B to G are fine (the paper presents the dataset, and they read the dataset's 3D). Fig 4A is fine. Fig 5A must use LUC3D's JavaScript.

## Work items

| ID | Item | Owner | Status |
|---|---|---|---|
| J2 | **Fig 2D** (12.6 mm at 13°, 2.7 mm at 31°, floor 1.2 mm) and **Fig 2B measured curve** (36% fewer, about 5 px) from v1.0.5 JS. Extend `fig2_solvers_by_views.mjs` to deposit per camera pair 3D error at k = 2, the k = 5 floor, and two-anchor held-out acceptance (`accN`, held-out reprojection within N px of that camera's own detection). Then repoint `panels/fig2_02` and `panels/fig2_04` at the new deposit and retire `fig2.json` | mimicc | todo (D1 = every 15th frame) |
| J3 | **Fig 2 export geometry onto v1.0.5 JS.** `fig2_solvers_export.py` undistorted, triangulated (alignment, sets `mm_per_unit`) and reprojected (identity matching) with cv2 + the NumPy DLT. All three now go through LUC3D (`lucid_geom.mjs`: `Camera.undistortPoint`, `triangulatePointDLT`, `reprojectPoint` + `distortPoint`); `fig2_measure.py` is no longer imported. No comparison against the NumPy export (Eric: we do not use NumPy, so the difference does not matter). Every Fig 2 deposit built on the export is rebuilt on the new one (`run_J_fig2.sh`, tag `js`) | mimicc | running |
| J4 | **Fig 5A** (`fig5_views.py`) onto v1.0.5 JS: the alignment triangulation through `triangulatePointDLT`, undistortion and the five 2D projections through the `Camera` class and `reprojectPoint`. Rewrite `out/fig5_views.json` with an R4 stamp. Rebuild its consumers: Fig 5A, the Fig 2D camera strip, and check whether the Fig 1 / Fig 5a Blender renders move (`blender-images/fig5a_scene.py`, `fig1_bmimica_scene.py`) | mimicc | todo |
| J5 | **Fig 3D** (identity-switch illustration). Today its 3D comes from a NumPy DLT and its association from a Python matcher (`blender-images/hardfight_common.py:155-241`), and the swap is staged. Rebuild it from a v1.0.5 run on the HardFight window (tracker + triangulation via `fig3_bench.mjs` with `LUCID_ROOT`, or the app served from the v1.0.5 checkout). How the switch is shown is D3 | mimic2 | todo, D3 |
| J6 | **Methods 0.13%** (every frame vs every 15th frame). It compares the NumPy run with the JS run. Recompute JS against JS or drop the sentence | mimicc | todo (Eric: recompute JS vs JS) |
| J7 | **Fig 2E bottom.** The solver is v1.0.5 JS but the drop rule is the driver's (always drop the single worst view, one pass, `fig2_solvers_robust_sessions.mjs:99-111`), while Methods describes the app's rule (above `reprojErrorThreshold`, iterative, `triangulation-core.js`) | mimicc | todo (Eric: reword Methods, keep the panel) |
| J8 | **App captures on the August working tree:** Fig 1 tracking tiles (`fig1_tracking.mjs`), Fig 2A tiles (`fig2_protocol.mjs`), both via `_drive.mjs` with `repoRoot` = working tree. Reshoot with the server rooted at the v1.0.5 checkout | mimic2 | D4 |
| J9 | `fig4_detections.py` NumPy triage fields (`signal`, `spearman`, `capture_*`) in the Fig 4C deposit. Not plotted. Delete them from the generator or port them, and grep the tex to confirm none is quoted | mimic2 | todo |
| J10 | Classify every G2 hit not listed above into the manifest allowlist, or move it to work | mimicc | todo |
| J11 | **Metadata that says the wrong thing.** `fig7_variant_best_c6b3.json` `luc3d_is_experimental`, `provenance` and `slap2m_luc3d_is_substituted` name `xv_experimental.js`, but the cells come from `fig8_methods_50_b3.json` (v1.0.5). Fix the generator (`fig6_variant_best_rebuild.py`) and the deposit, metadata only, cells untouched, backup first | mimic2 | todo |
| J12 | **Missing commit stamps.** The exhaustive caches, the `headtohead_b3` greedy caches and `fig2_cams_identity_b3.json` do not record their commit. Their v1.0.5 status rests on `run_B3Q.sh:20-21`. Add `lucid_root` / `lucid_commit` from the run scripts' asserted values, note the source, and add R4 refusal to `stale_sweep_slap2m.py` / `stale_ab_slap2m.py` (they require `LUCID_ROOT` but do not assert the commit) | mimic2 | todo |
| J13 | **Script defaults that are not v1.0.5.** `fig2g_retime_all.py:39` (`lucid-main-timing`) and `fig2_solvers_time_luc3d.mjs:27` (`lucid-bundle-adj`). Make `POSE_DIR` required and asserted. The current Fig 2G deposit used v1.0.5 and stands | mimicc | todo |
| J14 | **Methods "the benchmark drivers run the unmodified application modules".** True only after J2 to J5. Recheck it at G3 | mimicc | todo |
| J16 | **Fig 2G timing sitting on the LUC3D-built export** (Eric: "make sure the timing tests are real with luc3d and that there are not a bunch of other processes running"). `run_J16_fig2g_timing.sh`: waits for run_J_fig2, then `figs/timing_watch.py` measures every process's CPU from /proc, refuses to start if anything outside the sitting uses > 0.5 core or looks like ours (it caught the running export in a test), and watches the whole sitting. LUC3D side is `fig2_solvers_time_luc3d.mjs` with lucid_v105 asserting clean 2dc001fe; the deposit's `sitting.valid` is the watcher's verdict. T2 had no process check at all (convention only) | mimicc | queued |
| J17 | **Fig 3F timing (eric-mimic2, T1 + 4x6 sitting).** LUC3D side verified real (fig3_bench.mjs, `fig3f_timing_clean.py` refuses anything but 2dc001fe). Its process gate was name-based (`BENCH_MARKERS`), which already missed a 40-worker job once. Check its logs for CPU evidence; if there is none, rerun under `figs/timing_watch.py` (copy it to that host's run) | mimic2 | running: T1's `calls.jsonl` has only /proc/loadavg per call, no per-process CPU, so it is rerun. `out/md56_logs/run_J17_fig3f_timing.sh` (launched ~05:40 UTC) waits for the J12 re-derivation, prechecks with `timing_watch.py` (same as J16), then runs the full T1 sitting + the 4x6 cell under `T_TAG=_j17` with the watcher on the whole sitting and `fig3f_timing_clean.py`'s own per-call CPU gate. New deposits `fig3_*_clean_b3_j17*.json` carry `sitting.valid`. Earlier deposits untouched |
| J15 | Final build (X7) with G1 + G2 + G3 passing, then promote 2c / 3c / 6c to the main figures | mimicc | blocked on J2-J14 |

## Decisions for Eric

| ID | Question | Recommendation |
|---|---|---|
| D1 | Fig 2D (and 2B) on every frame, as now, or every 15th frame like 2C / E / F? | Every 15th frame. One LUC3D run, one keypoint set for all of Fig 2's triangulation panels. About 45 min including the driver change. Every frame is about 3 to 5 h and a new 30 GB export. Methods then says 2B / D use every 15th frame, and the 0.13% sentence (J6) is recomputed JS against JS or dropped |
| D2 | Fig 2E bottom: rerun with the app's real rule, or reword Methods to describe the panel's protocol? | Rerun with the app's rule (`triangulateAndReproject` with `reprojErrorThreshold`), so the panel tests the feature Methods describes. Needs a threshold, the app default or a stated value |
| D3 | Fig 3D: show a real switch found in a v1.0.5 run, or keep a staged swap drawn on v1.0.5 3D and say in the caption that it is illustrative? | Real v1.0.5 output for the 3D and the identities. If no switch occurs in the window, say the swap is illustrative in the caption |
| D4 | Reshoot Fig 1 tiles and Fig 2A on v1.0.5? | Yes. They show the app, so they should show the version under test |
| D5 | Fig 3E caption says box plots, the panel draws bars (from eric-mimic2) | Change the caption |

## Done means

- G1, G2 and G3 pass on the final build, and their outputs are committed.
- `fig2.json` and `fig2_measure.py` are not read by anything placed. `fig2_measure.py` is moved to `legacy/` with a note.
- Every `luc3d_js` deposit carries an R4 stamp at `2dc001fe`.
- Every Methods sentence about how a LUC3D number was made names code that does that.
- Every CSV change in the final build against the current figures is listed and explained.

## Log

- 2026-10-20 (eric-mimicc-0-1): plan written from the three audits. Nothing run yet. Commit `da433b01` on `eric/figs` holds the tex and figures from before this plan.
- 2026-10-20 ~04:10 UTC (eric-mimicc-0-1): Eric decided D1 = every 15th frame (2B/2D from the same stride-15 LUC3D run as 2C/E/F), D2 = reword Methods for Fig 2E bottom (keep the panel's single-worst-view protocol, say it is an analysis protocol), J6 = recompute the every-frame vs every-15th check JS against JS. eric-mimic2 runs its handoff on the other host. Tex backed up to `out/md56_logs/luc3d_newest.before_mimicc_JS_2026-10-20.tex`.
- 2026-10-20 ~04:30-05:15 UTC (eric-mimicc-0-1):
  - J13: `figs/lucid_v105.mjs` / `lucid_v105.py` resolve LUC3D: POSE_DIR (or LUCID_ROOT) required, must be clean `2dc001fe`, return the R4 stamp. Tested: no env refused, md56 passes, working tree refused. Wired into `fig2_solvers_by_views.mjs`, `_measure.mjs`, `_robust_sessions.mjs` (its default was the eric/figs WORKING TREE `pose/`), `_time_luc3d.mjs` (default `../lucid-bundle-adj`) and `fig2g_retime_all.py` (default `lucid-main-timing`). Each deposit now records lucid_root / lucid_commit / pose_dir / driver. Found: `fig4_robust_sessions_md56.json` (2E bottom) records no pose dir, and its 10-14 rerun log does not say which `pose/` it used, so it is rebuilt in run_J_fig2.sh.
  - `figs/lucid_geom.mjs` + `lucid_geom.py`: LUC3D v1.0.5 geometry for Python callers (triangulate = Camera.undistortPoint + triangulatePointDLT; project = reprojectPoint + distortPoint), stamped.
  - J2 driver: `fig2_solvers_by_views.mjs` now also deposits per pair DLT 3D error (`pairs_dlt_err3d_mm`, with baseline angle from LUC3D Camera centres) and held-out accN (`heldout_acc_by_k`). One-session test: every pre-existing field byte-identical to `fig4_by_views_md56.json`.
  - J3: a NumPy-vs-JS comparison of the alignment was started and STOPPED (Eric: why test the difference, we must not use NumPy). Its partial output was deleted. Export ported instead (see J3 row); one session in 9 s.
  - `run_J_fig2.sh` launched: export -> by_views (14 blocks) || measure -> robust -> Anipose on LUC3D's exact keypoints + check. Outputs `fig4_input_js`, `fig4_by_views_js`, `fig4_js`, `fig4_robust_sessions_js`, `fig4_anipose_jspad`.
  - Open for Eric: Fig 2G timing (`fig2g_retime_all.py`) also reads the export. Its solver inputs are the raw detections, which LUC3D's identity matching now selects. Rerun the timing sitting on `fig4_input_js` (quiet machine, about 1 h), or keep T2?
- 2026-10-20 ~05:00 UTC (eric-mimic2-0-6): **Eric's decisions.** D3: Fig 3D "fine as is" (kept; caption now says it is an offline illustration, not LUC3D output). D4: keep the Fig 1 / 2A captures (so their captions must not imply v1.0.5). D5: 3E is box-and-whisker, caption unchanged.
- 2026-10-20 (eric-mimic2-0-6): **independent audit** in `PROVENANCE-INVESTIGATION-mimic2-2026-10-20.md`. Disagrees with this plan on one point: placed **Supp 6G (s-DANNCE) is NOT v1.0.5**. `run_C6_build.sh` never set `FIG6_SDANNCE_AGG`, so it read `fig10-bench/results/agg` (lucid-switch-correct c9b2a325). The v1.0.5 rerun `results_v105/agg` gives an identical placed CSV, but **tex L423 "0.513" (wrong-calibration control) is the old checkout; v1.0.5 = 0.519**. New items for mimicc: rebuild fig6c with `FIG6_SDANNCE_AGG=figs/fig10-bench/results_v105/agg`; L423 -> 0.519. That file's section 3 lists ~15 further items this plan does not have.
- 2026-10-20 (eric-mimic2-0-6): **J11 done.** `fig6_variant_best_rebuild.py` writes `lucid_root`/`lucid_commit`/`driver`/`luc3d_source`/`legacy_blocks_note` from the source deposit and refuses an experimental source; `luc3d_is_experimental` dropped. `fig7_variant_best_c6b3.json` patched (metadata only, 16 data keys asserted unchanged, backup `out/md56_logs/x6_backup_2026-10-20/`). Win counts rechecked on the no-dedupe ByteTrack arm: identical. `fig7_fair_baselines_c6b3nd.json` names no fork.
- 2026-10-20 (eric-mimic2-0-6): **J9 code done.** `fig4_detections.py` part B (NumPy DLT + OpenCV) is opt-in `FIG4_PY_TRIAGE=1`, default off, `fig2_measure` imported only there. Backup `out/md56_logs/fig4_detections.before_J9_2026-10-20.py`. Deposit not regenerated (no panel or tex reads B).
- 2026-10-20 (eric-mimic2-0-6): **Fig 3 text** (backup `out/md56_logs/luc3d_newest.before_mimic2_JS_2026-10-20.tex`): L285 now says the exhaustive arm triangulates with LUC3D's code and describes its added Hungarian 3D-centroid identity threading (drives the 4.2 /100k and 0.847 reference in 3G/H); L289 "twelve" -> "twenty values of r from 0 to 24"; timing Methods adds "headless in Node.js 26 on the modules of LUC3D v1.0.5"; Fig 3D caption adds the illustration sentence (D3).
- 2026-10-20 (eric-mimic2-0-6): **J12 running.** New `figs/provenance_rederive.py` reruns all 196 cached Fig 3 greedy runs (`headtohead_b3` + `headtohead_var_b3_2dc001fe/distanceThreshold25-stale20_f7733dbf`) at clean 2dc001fe and compares the tracker output digest, instead of trusting run-script logs (the SLAP-2M cells were copied from an md56 run whose script never asserted the commit).
- 2026-10-20 ~05:20 UTC (eric-mimic2-0-6): **timing audit (Eric: "make sure the timing tests are real with luc3d and no other processes").** 3F T1 + 4x6: timed outputs re-derived identical at v1.0.5 (5/5 configurations), gates passed, nothing of ours overlapped. 2G T2: v1.0.5 by pose_dir + md56 reflog (never moved since the 10-14 clone), but `run_T2.sh` had no process gate or commit assert. **For mimicc: any Fig 2G retime (open item above) must (a) assert 2dc001fe clean, (b) gate on all processes in the container, as `fig3f_timing_clean.py` now does (`other_cores`, <= 1 core), and (c) not run while `run_J_fig2.sh` or anything else of ours runs on that host.** Tex L200 "0.13 to 0.24 ms" -> "0.24 to 0.65 ms", L285 load wording fixed. Also for mimicc: L303 0.42 -> 0.41 (best-round rule).
- 2026-10-20 ~07:10-08:30 UTC (eric-mimicc-0-1):
  - run_J_fig2.sh DONE 07:09: export `fig4_input_js` (LUC3D geometry, 19,079,132 keypoints, one fewer than the NumPy-built export), `fig4_by_views_js` 04:45, `fig4_js` (2F LUC3D) 05:40, `fig4_robust_sessions_js` (2E bottom, gate PASSED) 05:58, `fig4_anipose_jspad` 07:09 (56/56 sessions optim n == LUC3D n). All stamped 2dc001fe.
  - J16 sitting DONE 07:57, watcher valid (max outside 0.456 cores = VS Code server; host load median 6.2). Anipose and LUC3D refined stable across rounds (within ~2%); LUC3D DLT NOT stable (1.08-2.01 us across rounds; one 200,010-keypoint pass is ~0.2 s, fresh process per round, best-of-5). Proposed protocol (warm full pass, 20 timed passes per round, median + spread for every arm, taskset one core) waiting on Eric. Tex 2G numbers (32x, 5.0x, 0.95 us, 0.42 / 2.19 us, 133x) NOT changed; fig2c 2G still reads T2.
  - fig2c REBUILT from LUC3D deposits (Eric: "rebuild the panels in 2c"). Variant `f2js` (links: fig4 -> fig4_js, fig4_by_views -> fig4_by_views_js, fig4_robust_sessions -> fig4_robust_sessions_js, fig4_anipose -> fig4_anipose_jspad, fig2g_retime_all -> md56T2 pending the timing decision), FIG_VARIANT_REQUIRE on all five, FIG_TAG=c, log `md56_logs/FIG2C_js_make_figures.log`, loads `FIG2C_js_loads.tsv`. 11 panels, 0 failed. `fig2.json` is no longer read. Panels repointed: `fig2_02` (2B) reads `heldout_acc_by_k`, `fig2_04` (2D) reads `pairs_dlt_err3d_mm` + `by_k['5']`, both refuse an unstamped deposit; `fig2_03 main_cdf` (fig2.json, never placed) now exits. Backup of the previous fig2c: `md56_logs/fig2c_before_js_2026-10-20/`.
  - CSV diff vs previous fig2c: every value within 0.4% (largest: 2D err3d 0.34%, 2C agg_p25 0.21%), except 2D `n` (-93%, every 15th frame instead of every frame, D1) and 2G-optim `padded` (padding frames). 2G time CSV identical (T2). Every tex Fig 2 number still holds: 75 -> 32.46 (2.31x), 47.68 (36.4% fewer), 4.737 / 1.208 mm, 12.60 mm at 13.5 deg, 2.68 mm at 31.5 deg, 4.269 -> 3.298 px, 2F medians 2.146-2.340, refined lowest 56/56.
  - Still NumPy in fig2c: the 2D camera strip reads `fig5_views.json` (J4).

