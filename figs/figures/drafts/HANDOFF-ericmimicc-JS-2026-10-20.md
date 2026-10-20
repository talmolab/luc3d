# Handoff: eric-mimicc-0-1, LUC3D JavaScript pass, 2026-10-20

**Goal.** Every Fig 2 and Fig 5A number the paper attributes to LUC3D comes from LUC3D v1.0.5's JavaScript, not from Python. Then the provenance gate, the final build and the promotion of 2c / 3c / 6c.

**Estimate.** 4 to 6 h of work, plus about 1 h of machine time at every 15th frame (D1). Every frame adds about 3 to 5 h.

## Read first

1. `figs/figures/drafts/LUC3D-JS-CONSISTENCY-PLAN-2026-10-20.md`: rules R1 to R5, gates G1 to G3, items J2 to J15, decisions D1 to D5. **This file is the source of truth. Log every step there.**
2. `figs/figures/drafts/CONSISTENCY-PLAN-2026-10-19.md`: rules 1 to 9 still hold. Rule 9: Fig 2 triangulation keeps all 15 nodes.
3. `figs/fig2_solvers_by_views.mjs` header: why the JS driver exists.

## Ground rules

- **Do not assume. Verify, then act.** If a fact is not in a file you read, ask Eric.
- LUC3D = `/root/vast/eric/lucid-main-md56` at `2dc001fe527c4dbaad17fa171da132cfdfe010e6`. Check it is clean before every run (`git -C /root/vast/eric/lucid-main-md56 status --porcelain --untracked-files=no` prints nothing).
- Python never triangulates, reprojects, undistorts or tracks for LUC3D (plan R2). It may score and plot.
- Every new deposit carries the R4 stamp: `lucid_root`, `lucid_commit` read at run time, `driver`, `generated_by`. Scripts refuse to run off `2dc001fe` or on a dirty checkout.
- Never overwrite a deposit a figure reads. Write tagged new files, back up anything you change, and diff.
- Nothing else of ours runs during a timing measurement. This pass has none.
- Both hosts share `/root/vast` and edit `luc3d_newest.tex`, and Eric edits it too. **Do not touch Fig 3 text** (eric-mimic2). Back up the tex before your first edit (`figs/out/md56_logs/luc3d_newest.before_mimicc_JS_2026-10-20.tex`). Grep-verify after every edit. Line numbers drift.
- Tex style: short plain sentences, no semicolons or colons in prose, no "Because" openers.
- Commit to `eric/figs` only when Eric asks.

## Environment

- Node: `export PATH=/root/vast/eric/node26_env/bin:$PATH` (v26.10.0).
- LUC3D modules: `POSE_DIR=/root/vast/eric/lucid-main-md56/pose`.
- Python for the export and bench scripts: `/root/vast/eric/luc3d-bench/lp3d_env/bin/python` (cv2, toml). Figures: `figs/.venv/bin/python`. Stats: `/root/miniforge3/envs/track_mjx/bin/python`.
- The template run is `figs/out/md56_logs/run_F2a.sh`. It ran `fig2_solvers_by_views.mjs` in 14 blocks (`BLOCKS=a:b STRIDE=1 OUT_JSON=...`) on `figs/out/fig4_input_md56.bin` (stride-15 export, 19,079,133 keypoints, 56 sessions) and merged with `--merge`. The whole thing (k = 2 to 5, DLT and refinement, 992M solves) took 20.5 min.

## Before starting: ask Eric

- **D1** sampling for 2D / 2B: every 15th frame (recommended) or every frame.
- **D2** Fig 2E bottom: rerun with the app's real drop rule (recommended, plus which threshold) or reword Methods.
Record the answers in the plan. Do not start J2 or J7 without them.

## Tasks, in order

1. **J13, script defaults.** In `fig2g_retime_all.py` (L39) and `fig2_solvers_time_luc3d.mjs` (L27), remove the non-v1.0.5 defaults. Make `POSE_DIR` required, and assert its repo is at `2dc001fe` and clean. Apply the same assert to `fig2_solvers_by_views.mjs`, `fig2_solvers_measure.mjs`, `fig2_solvers_robust_sessions.mjs` and `fig2_solvers_export.py`'s callers. No rerun needed for 2G.

2. **J3, reference alignment.** `fig2_solvers_export.py` (L158-163) aligns the proofread 3D into the calibration frame with a NumPy DLT plus RANSAC. That sets `mm_per_unit`, which scales 2C. Replace the triangulation with a call to v1.0.5 `triangulatePointDLT` (a small node helper reading a binary batch, as the drivers do). Rerun the alignment only. Compare the similarity transform and `mm_per_unit` per session with the current `fig4_input_md56.json`, and report the maximum difference.
   - **If identical to float precision**, record that and keep the export.
   - **If not**, write a new export (`fig4_input_js.bin`), then rerun 2C / E / F through `run_F2a.sh`'s pattern into tagged deposits, and diff.

3. **J2, Fig 2D and the 2B measured curve.** Extend `fig2_solvers_by_views.mjs`, keeping everything it deposits today byte-identical (check with a one-block run against `fig4_by_views_md56.json`). Add:
   - per camera pair (k = 2, the 10 subsets) 3D error to the proofread reference: p50 and n per session and pooled, with the pair's camera indices;
   - the k = 5 3D error floor (already in `by_k['5']`, just confirm);
   - two-anchor held-out acceptance: for each pair, the share of held-out reprojections within 2, 5, 10, 20 and 40 px of that camera's own detection (the `TAU_PX` list from `fig2_measure.py`), as `accN`.
   Run all 56 sessions at the D1 sampling into a new tagged deposit (for example `fig2_pairs_js.json`) with the R4 stamp.
   - Repoint `panels/fig2_04_baseline_angle.py` (L146-164) and `panels/fig2_02_placements_vs_rig.py` (L93-103) at it.
   - The camera baseline angle can stay in Python. It is geometry of the calibration, not a LUC3D solve.
   - Rebuild fig2c into a new tag, then diff `fig2b_placements_vs_rig.csv` and `fig2d_baseline_angle.csv` and list every change.
   - Move `fig2_measure.py` to `legacy/` with a note, and confirm nothing placed reads `fig2.json`.

4. **J6, the 0.13% sentence** (Methods, "agreed to within 0.13% at every camera count"). Under D1 = every 15th frame, either recompute JS every frame against JS every 15th frame on a few sessions, or drop the sentence. Ask Eric which. Also update the Methods sentence that says 2B / D use every frame.

5. **J7, Fig 2E bottom**, per D2.
   - **If rerun:** add a mode to `fig2_solvers_robust_sessions.mjs` that calls v1.0.5 `triangulateAndReproject` with `reprojErrorThreshold` set (the app's own iterative per-node loop, `triangulation-core.js` around L1444-1499) instead of the driver's single-worst-view drop (L99-111). Rerun, rebuild, diff `fig2e_worst_camera.csv`, and update the panel title and Methods.
   - **If reword:** Methods says the panel drops the single worst view of each keypoint as an analysis protocol, and that the app's own feature uses a threshold.

6. **J4, Fig 5A.** `fig5_views.py` imports `triangulate_batch` from `fig2_measure.py` (L55) for the P-frame-to-calibration alignment (L117-121). It reprojects the five 2D overlays with `cv2.projectPoints` (L190) after cv2 undistortion.
   - Move all three steps onto v1.0.5 JS: `triangulatePointDLT`, the `Camera` class's undistort / distort, and `reprojectPoint`. Rewrite `out/fig5_views.json` under a new name with the R4 stamp, then diff it against the old one (alignment transform, `pose_mm`, the 2D overlays).
   - Then check every consumer: `panels/fig5_05_upright_views.py` (also check what it projects itself), `panels/fig2_04_baseline_angle.py` (camera strip), `blender-images/fig5a_scene.py` and `fig1_bmimica_scene.py` (render cameras).
   - If the alignment moves, re-render the affected Blender images and say so in the log.

7. **J10 + G1 + G2, the provenance gate.** Write `figs/provenance_manifest.json` and `figs/provenance_gate.py` exactly as the plan's G1 / G2 describe.
   - Classify every deposit the final build reads, and every G2 static hit, with a reason.
   - Hits the plan lists as "classify": `fig1_bmimica_scene.py`, `blender-images/cage_scene.py`, `blender-images/slap2m_movie.py`, `fig4_idf1_3d.py`, `fig4_pose.py`, `panels/fig5_05_upright_views.py`. For each, find whether a placed panel uses it, and what it computes.
   - The gate must fail on `fig2.json` and on any unlisted geometry call.

8. **J14 + G3, tex.** Grep Methods for every sentence that says how a LUC3D number was made ("the application", "LUC3D", "triangulat", "reproject", "drop", "every frame", "every 15th"). Check each against the manifest's generator. Fix the ones you own and list Fig 3 ones for eric-mimic2.
   - Includes "The benchmark drivers run the unmodified application modules" (Software).
   - Includes the 2B / D sampling sentence.

9. **J15, final build.** When eric-mimic2 logs J5, J8, J9, J11 and J12 done:
   - Rerun `out/md56_logs/run_X7_build.sh` from clean. Delete only the `*_x7.json` symlinks and the `figures/fig*x7*` / `data/fig*x7*` dirs.
   - Add the new deposits to its link set.
   - Fix the known Fig 4 failure first. `panels/fig4_14_occlusion.py` picks its deposit by variant name and only knows `''`, `predslp` and `proofread`, so under `x7` it found nothing. Read how the main Fig 4 build chose it, then make `x7` resolve to the same file explicitly. Do not guess.
   - G1 / G2 / G3, S4 and M6 must pass. Diff every CSV against the current figures and explain each change.
   - Then promote 2c → 2, 3c → 3 and 6c → 6 the way commit `01fb3530` promoted the b series. Rebuild main from the same inputs, assert CSVs byte-identical to the tagged twins, point the tex at `fig2.pdf` / `fig3.pdf` / `fig6.pdf`, and delete the c series in a separate commit.
   - Note: `data/fig6c/fig6f_pr_switches.csv` is a Mouse-Dyad leftover of an unplaced panel. Panel F reads `data/fig6slapstale/`. Ask Eric whether to drop it from the promoted `data/fig6`.

## Done means

- J2, J3, J4, J6, J7, J10, J13, J14 and J15 are ticked in the new plan, each with its deposit, commit stamp and CSV diff.
- G1, G2 and G3 pass. `fig2.json` is read by nothing placed.
- The tex still has 16,030 and 14,694 (Eric's in-app numbers), includes `fig2.pdf` / `fig3.pdf` / `fig6.pdf`, and no Methods sentence describes Python as LUC3D.
