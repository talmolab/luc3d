# Settings behind fig2b, fig3b and fig6b (md56, 2026-10-14)

This file lists exactly what was run to make `figures/fig2b/`, `figures/fig3b/` and
`figures/fig6b/`. It covers data, code version, tracker and solver settings, software
versions, and the machine conditions for every timed number. The logs are in
`figs/out/md56_logs/`.

> **Fig 2b panel G** was rebuilt at 16:10 from the clean single-threaded sitting Q2c (§5).
> Before that it showed a timing run with a multithreaded BLAS (≈190 threads) on a loaded
> machine.


> **Release: LUC3D v1.0.5** (tagged 2026-10-14) is commit **2dc001fe**, the exact commit
> pinned at `/root/vast/eric/lucid-main-md56` for every md56 run on main. Wherever this file
> says `origin/main 2dc001fe`, that is v1.0.5. Only v1.0.5 is to be used from here on.

---

## 1. Settings shared by all three figures

### Corpus
All 56 Mouse-Dyad-10M (BMimica) sessions, 5 cameras, 2 animals, 15-node skeleton. The
42 multi-animal SLAP-2M sessions take part only in Fig 3E/F.

`figs/md56_check.py` gated the build. Every Mouse-Dyad deposit had to exist as `_md56` and
cover exactly 56 sessions (`md56_logs/B_gate.log`: PASSED on 20 of 20). The build ran with
`FIG_VARIANT_REQUIRE` set, so a panel could not fall back to a 50-session file. The audit
of the files each panel read is `md56_logs/B_loads.tsv`.

### The six new sessions
The six new sessions are `20250908_152229`, `_154926`, `_161812`, `_164528`, `_171240`
and `_173928`.

- **Calibration.** `20250904115349_calibration.toml` was copied into
  `BMimica/20250908_*/calibration/`. It is byte-identical to the file used by all 34
  sessions from 09-03 to 09-07.
- **GT fit.** The ground-truth fits match the other 50: scale 1012.8–1012.9, inliers
  0.96–0.98, residual 1.22–1.30 mm.

### Bench inputs
Phase U built these. It is additive: the 50 old sessions were skipped because their files
already existed.

| Input | Script | Settings |
|---|---|---|
| SLEAP re-track | `bmimica_retrack_all.py` | sleap-nn 0.3.0 / sleap-io 0.8.0, run through `sleap_nn_030_fix` (Python 3.11.10). Flags: `--filter_min_instance_score 0.85 --filter_min_mean_node_score 0.55 --filter_min_visible_nodes 8 --filter_overlapping --filter_overlapping_method oks --filter_overlapping_threshold 0.50 --tracking --tracking_window_size 15 --tracking_target_instance_count 2 --post_connect_single_breaks` |
| Ground truth | `bmimica_build_gt.py` | Proofread 3D reprojected into each camera through a RANSAC similarity fit, with OpenCV 4.13.0 headless |
| Detection pool `det_h5/` | `bmimica_build_inputs.py` | From `retracked/`; 280 camera-sessions |

**Control.** The repaired sleap-nn 0.3.0 env re-tracked old session `20250827_141755`.
Its output was identical to the deposited tracks on all 5 cameras.

### Tracking scoring
- **Package:** motmetrics 1.4.0 (`liezl_env`, Python 3.12.7, NumPy 2.4.6, SciPy 1.17.1).
- **Matching:** IoU 0.5 (`max_iou=0.5`).
- **Tail nodes:** `SCORE_NOTAIL=1`, so the 4 tail nodes (TailTip, Tail_0–2) are excluded,
  the same as the tail-free (bvis5nt) run.

### Code versions
| Use | Code |
|---|---|
| Fig 2 solvers (accuracy and timing) | `origin/main` **2dc001fe** (2026-10-13, includes #208 and #300), checked out at `/root/vast/eric/lucid-main-md56`. Not a release; it is about 40 commits after v1.0.4. |
| Exhaustive arm, Fig 3F timings | Same 2dc001fe, through `LUCID_ROOT` |
| Tracking accuracy (fresh anchor, sweeps, staleness configs, camera subsets) | The `eric/figs` branch's `pose/` through `figs/fig6-bench/fig6_bench.mjs` + `xv_experimental.js`. On full session `20250827_141755` its tracker output is **bit-identical** to 2dc001fe. |
| Node | v26.10.0 (`node26_env`) for every driver |

---

## 2. fig2b

| Panel | Source deposit | Settings |
|---|---|---|
| A | `fig2-protocol.json`, `fig2a_scene.json` (base, unchanged) | Illustration of one HardFight frame; not rerun |
| B, D | `fig2.json` (base, already 56 sessions, every frame) | Unchanged. `fig2_measure.py` uses its own NumPy SVD DLT. τ = 10 / 5 px; band ±25% |
| C | `fig4_by_views_md56.json` | Export: `fig2_solvers_export.py --stride 15` gives 19,079,133 keypoints over 56 sessions and 3 calibrations. By-views: `fig2_solvers_by_views.mjs`, `STRIDE=1`, sharded `BLOCKS` 0:5…53:56, then `--merge`. Pose: 2dc001fe. Plotted: held-out px across sessions; `err3d_mm` deposited |
| E (top) | `fig4_by_views_md56.json` | As C |
| E (bottom, worst camera) | `fig4_robust_sessions_md56.json`, `fig4_md56.json` | `fig2_solvers_robust_sessions.mjs` with `POSE_DIR`=2dc001fe and hooks = `fig2_solvers_hooks.mjs`. Gate vs `fig4_md56.json` PASSED (\|Δ\| ≤ 5e-13) |
| F | `fig4_md56.json` (LUC3D) + `fig4_anipose_md56.json` (Anipose) | LUC3D: `HOV_SUB=1 DSTEP=1 node fig2_solvers_measure.mjs`, `POSE_DIR`=2dc001fe, stub defaults `triangulationMethod='dlt'`, `reprojErrorThreshold=0`. Anipose: `fig2_solvers_anipose.py --jobs 12 --optim-jobs 12 --optim-sweep 1000 2000 4000 8000 16000 23000` in `anipose072_cv413_env`: aniposelib 0.7.2, **opencv-contrib-python-headless 4.13.0.92**, NumPy 2.4.6, SciPy 1.18.0, numba 0.66.0, Python 3.12.7. Linear = `CameraGroup.triangulate`; "optim, no smoothing" = `optim_points(scale_smooth=0, n_deriv_smooth=1)`. Anipose accuracy is identical to the old OpenCV 5.0.0 run on all 50 old sessions (max \|Δ\| 0.0) |
| G | `fig2g_retime_all_md56.json` | From Q2c (§5). Protocol: `fig2g_retime_all.py --rounds 5` (best of 5, alternating libraries), then `fig2g_retime_extra.py` (Anipose undistortion and RANSAC) and `fig2_anipose_optim_retime.py`. n = 200,000 for the linear solvers, 345,000 (23,000 frames × 15 joints) for Anipose optim. Undistortion is excluded from every solve time. LUC3D times come from `fig2_solvers_time_luc3d.mjs` with `POSE_DIR`=2dc001fe |

**Accuracy is the same across code versions.** On 200,000 keypoints:
- **#300 vs the commit before it:** DLT \|ΔX\| ≤ 1.4e-12 mm.
- **Sep 29 code (1d672c12) vs 2dc001fe:** median 0.0018 mm, from #208's normalizing frame.
  Mean reprojection 1.99267 → 1.99264 px; error to proofread 1.76397 → 1.76382 mm.

---

## 3. fig3b

| Panel | Source deposit | Settings |
|---|---|---|
| A–D | illustrations / analytic counts | Not rerun |
| E | `fig3_quality_md56.json` (exhaustive) + `fig3_quality__distanceThreshold25-stale20-sync_e508a7ab_md56.json` (greedy) | 98 sessions: 56 Mouse-Dyad + 42 SLAP-2M. SLAP-2M pool `lite_pools/bvis5`: unfiltered predictions minus detections with < 5 visible body keypoints. **Exhaustive** (`fig3_exhaustive.mjs`): `--exclude-tail`, `--max-hypotheses 1000000`, clean-frame caps A3_C5 2,000 and A4_C3 1,000 (`HH_CLEAN_A3/A4`), run on 2dc001fe. **Greedy**: `fig3_hh_freshanchor.py --run --jobs 16`, `{"sync":true,"stale":20}` + `distanceThreshold 25`, corr3dWeight 6, corr2dWeight 1 (the current tracker) |
| F | exhaustive: `fig3_headtohead_md56.json` `seconds_per_frame_exhaustive`; LUC3D: `fig3_runtime_md56.json` `measured` | **Exhaustive:** `LUCID_ROOT=2dc001fe HH_JOBS=16 fig3_headtohead.py`. Every exhaustive and greedy cell for all 98 sessions was re-run in one pass, **16 jobs in parallel** (the original protocol), 11:09–12:32, load 4.7–17. **LUC3D:** `LUCID_ROOT=2dc001fe fig3_scale_runtime.py` with `fig3_bench.mjs` default thresholds (`MAX_FRAMES=3000`, the first 3,000 frames of each cell's session), 13:18–13:21, load ≈ 1.9–2.7. Both are JavaScript (single-threaded per process); the BLAS issue in §5 does not apply. Ratio label repositioned (`hi^0.6·lo^0.4`) |
| G, H (sweep lines) | `fig3_sweep50__…e508a7ab_md56.json` (current tracker), `fig3_sweep50_md56.json` ("previous default") | Run on **ericmimicc** (`run_S.sh`, 62 workers, fresh env pinned to NumPy 2.4.6 / h5py 3.16.0 / motmetrics 1.4.0 / pandas 2.3.3 / SciPy 1.17.1). Grid: corr3d ∈ {0, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24}, corr2d = 1. Current tracker: `{"sync":true,"stale":20}` + `distanceThreshold 25`. Previous default: pre-#210, `distanceThreshold 50` pinned explicitly, no eviction, no sync. That pin reproduces the cached cells bit for bit |
| G, H (flat rules) | `fig3_exhaustive_bmimica_md56.json`, `fig3_frame_matched_bmimica_md56.json` | Exhaustive over all 56 sessions. Frame-matched: exhaustive and the head-to-head **greedy = current tracker** (changed from pre-#210; Eric's decision), scored on the frames exhaustive computed. `FM_JOBS=12` |

---

## 4. fig6b

| Panel | Source deposit | Settings |
|---|---|---|
| A, LUC3D | `fig7_variant_best_md56.json` (built by `fig6_variant_best_rebuild.py --tag md56 --base bvis5nt`) ← `fig8_methods_50_md56.json` cell `sync_stale20_dist25` | `fig6_methods.py --all-sessions`, `FIG8M_WORKERS=20`. The rebuild script reproduces the hand-built bvis5nt file (`--check` PASSED) |
| A, SLEAP | `fig7_fair_baselines_md56.json` ← `fig7_sleap_max2_md56.json` | sleap-nn 0.3.0 with the bench-input flags (§1) plus `--max_tracks 2 --candidates_method local_queues --tracking_clean_instance_count 2`. Every output verified at ≤ 2 tracks. Scored camera-scoped by `fig6_sleap_scoped.py` |
| A, ByteTrack | `fig7_fair_baselines_md56.json` ← `fig7_bytetrack_max2_md56.json` | supervision 0.30.0 (`eks_env`). Arm B1s: `lost_track_buffer = n_frames` (never retire) on tail-free boxes, `track_activation_threshold 0.25`, `minimum_matching_threshold 0.9`, then the 2-identity stitch |
| F | `fig8_methods_50_md56.json` | Configs: `shipped` (= previous default, `distanceThreshold 50` pinned, no eviction); `sync_stale1_dist25`, `sync_stale10_dist25`, `sync_stale20_dist25`, `sync_stale30_dist25`; `dist25_corr36`. The 50 old sessions are bit-identical to the bvis5nt deposit in every config |
| B–E, G–I | base deposits | SLAP-2M / s-DANNCE only; not rerun |

The camera subsets, used in the text (not a b figure), come from `fig2_cams_identity_md56.json`:
- `fig2_cams_identity.py --stage track` then `--stage score`.
- The same 3 fixed subsets per k ∈ {2, 3, 4} plus the full rig, 560 runs.
- Current tracker. The k = 5 gate against `sync_stale20_dist25` passed.
- The first pass covered only 50 sessions and was stopped and redone (`run_T2.sh`).

---

## 5. Every timed sitting, and its conditions

| Sitting | When (UTC) | What | Conditions | Status |
|---|---|---|---|---|
| Q2 | 10:58–11:09 | Fig 2G retime | numba = 1 thread only, BLAS/OpenMP unpinned; load up to 17. Companion `fig2_anipose_optim_retime.py` crashed (`os` not imported) | **Invalid.** Drawn in the current fig2b G |
| Q2b | 15:05–15:32 | Fig 2G retime + extra + optim | Same thread problem (≈190 threads in the Python process) and overlapped a number-checking job; load up to 39 | **Invalid.** Kept as `md56_logs/fig2g_retime_all_md56.Q2b-multithreaded.json` |
| **Q2c** | 15:45–16:08 | Fig 2G retime (15:45–15:55) + extra (–15:56) + optim (–16:08) | `NUMBA/OMP/OPENBLAS/MKL/VECLIB/NUMEXPR_NUM_THREADS=1`, `UV_THREADPOOL_SIZE=1`. The timing process held **1 thread throughout**. Started at 1-min load < 1. The host was ~98% idle during the main retime; host load from other containers rose to 16.9 only during the optim companion, which is not drawn in G. Recorded in the deposit's `sitting` block | **Used** for fig2b G |
| Q3 | 11:09–12:32 | Fig 3F exhaustive (all 98 sessions, both arms) | 16 parallel jobs by design, the same protocol as the original Fig 3 run | Used |
| Q4 | 13:18–13:21 | Fig 3F LUC3D seconds/frame | Single node process per cell; load ≈ 2–3 | Used |

---

## 6. What is NOT the same as before (by design)

- **Sessions:** 50 → 56 (Mouse-Dyad); 92 → 98 in the head-to-head.
- **Code for all timings:** 2dc001fe, which is faster. Before, Fig 2G used 1d672c12 (Sep 29)
  and Fig 2E/F used the Aug 4 `eric/bundle-adj` branch.
- **Anipose OpenCV:** 5.0.0 → 4.13.0 (accuracy unchanged).
- **Head-to-head / frame-matched greedy arm:** pre-#210 → the current tracker.
- **Fig 3F:** both arms now timed on the same code; exhaustive re-run on 2dc001fe.
- **Previous-default arm:** `distanceThreshold 50` is now pinned explicitly instead of
  inherited from bench defaults (output identical).

---

## 7. v1.0.5-only rebuild of fig3b and fig6b (2026-10-15)

Eric: every figure on v1.0.5 (2dc001fe), consistent. fig3b and fig6b were rebuilt with
`FIG_VARIANT=v105 FIG_TAG=b FIG6F_NOEVICT=stale0_dist25` (logs `out/md56_logs/V105_*`).
`out/*_v105.json` are symlinks to the `_md56` deposits, except:
- `fig3_sweep50_v105.json` → `fig3_sweep50__distanceThreshold50-stale0_ce1d7f8d_md56main.json`
  (3G/H "previous default" line = v1.0.5 at distanceThreshold 50, stale 0; no longer pre-#210).
- `fig3_sweep50__…e508a7ab_v105.json` → `…distanceThreshold25-stale20_f7733dbf_md56main.json` (3G/H current tracker).
- `fig3_quality__…e508a7ab_v105.json`, `fig3_headtohead__…e508a7ab_v105.json` → `out/md56main/…f7733dbf_md56.json` (3E greedy on v1.0.5).
- Supp 6F "stale 0" point = `stale0_dist25` (v1.0.5, eviction off), not the pre-#210 `shipped` cell.
  The eviction text (L415/L417) compares against `stale0_dist25`; "best re-tuning without
  eviction" = `stale0_dist25_corr36`.
The pre-rebuild fig3b/fig6b are backed up in the session scratchpad. §3/§4 above describe the earlier build.
