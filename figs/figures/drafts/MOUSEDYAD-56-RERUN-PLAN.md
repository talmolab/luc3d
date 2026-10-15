# Mouse-Dyad-10M on all 56 sessions — rerun plan (2026-10-14)

Goal: every Mouse-Dyad-10M analysis in the paper runs on all 56 sessions, with the same
software versions everywhere. New results are built as **b variants** (`fig2b`, `fig3b`,
`fig6b`). Nothing official is overwritten until Eric approves. After approval, the b
deposits replace the base ones and `luc3d_newest.tex` is updated.

## Naming

- Measurement outputs: `out/<name>_md56.json`. The figures read them through
  `FIG_VARIANT=md56` (`src/data_loader.py`).
- Figures: `FIG_TAG=b` writes `figures/fig2b/`, `figures/fig3b/`, `figures/fig6b/` and
  `data/fig2b/` etc.
- Caches: new `out/tmp/*_md56/` directories. Each one is **seeded by copying** the 50
  sessions' per-session results from the current tail-free cache (`*_bvis5nt`, which is
  byte-identical to today's base deposits). Only the six new sessions are computed, except
  where marked FULL below.
- Upstream bench (`luc3d-bench/outputs/bmimica/`): the six sessions are added next to the
  50. Existing files are not touched. `bmimica_master.tsv` is backed up before it is
  rewritten.
- Settings carried over from the tail-free run: `SCORE_NOTAIL=1`, tail nodes excluded in
  every arm.

## Already done

- `20250904115349_calibration.toml` copied into the six empty
  `BMimica/20250908_*/calibration/` folders. It is the rig file for all 34 sessions from
  09-03 to 09-07, and Fig 2B/D already used it for 09-08 (RANSAC inliers ~0.977, residual
  ~1.23 mm).
- The old explanation for leaving the six out ("too little cross-camera overlap",
  `fig5_benchmark_subset.py`, commit f1bfe3e) is wrong. The only cause was the missing
  calibration. `fig2_measure.py` prints one message for both cases.

## Versions — one set for the whole paper

| What | Version used | Action |
|---|---|---|
| Calibration comparison (Supp) | aniposelib 0.8.0, OpenCV 4.13.0 | none, already consistent |
| Anipose triangulation, Fig 2F/G | aniposelib 0.7.2 with **OpenCV 5.0.0** (`anipose_env`) | new env `anipose072_cv413` with aniposelib 0.7.2 + opencv-contrib-python 4.13.0.92, numpy 2.4.6; **FULL rerun** of the Anipose arm on 56 |
| LUC3D drivers, timing | Node 26 (v26.5.0 / v26.10.0 recorded) | all timed runs on `node26_env`, one version, recorded in each deposit |
| SLEAP baseline | sleap-nn 0.3.0, sleap-io 0.8.0 (recorded in the 50 `.slp` files) | `sleap_nn_030_env` is broken; rebuild a venv with the `.pth` workaround and check that `sleap_nn.__version__ == "0.3.0"` before tracking the six |
| ByteTrack | `supervision` in `eks_env` (0.30.0) | check that it matches the version recorded in the 50 B1 outputs |
| Scoring | motmetrics 1.4.0 (`liezl_env`) | add the version to the Methods |
| Analysis | Python 3.12.7, NumPy 2.4.6 (bench envs) / 2.5.1 (figure `.venv`) | plotting only, no action; the Methods says "Python 3.12" |

Each new deposit records its package versions so the Methods text can be checked
against the files.

## Tracker version — decision needed

PR #210 (2026-08-25) changed the tracker defaults: fresh anchor, distanceThreshold 50 → 25,
stale 20. Some cached LUC3D outputs for the 50 sessions are **from before #210**:

- `headtohead*/A2_C5_bmimica/*/greedy.json` (08-11). Fig 3G/H's frame-matched rule
  ("8.1 switches at IDF1 0.800") reads it.
- the `shipped` arm of `fig8m50` and of `fig3_sweep50`.

Meanwhile the sweep point it sits next to (r = 6: 0.78 and 0.865) is the current tracker.
So the paper already mixes the two trackers in one sentence (tex line 150).

**Recommendation:**
- Every LUC3D number is the current tracker, except the one place that deliberately shows
  the old one: Supp Fig 6F / line 415's "before eviction" arm (1,917 → 349). That arm
  keeps old settings pinned explicitly (distanceThreshold 50, stale 0), and the text says
  so.
- The frame-matched rule is recomputed with the current tracker on all 56 sessions,
  reading the fresh-anchor cache (`fig3_hh_freshanchor`). The 8.1 / 0.800 numbers will
  change.

## Steps (dependency order)

Env for all figs/ steps: `PY=luc3d-bench/liezl_env/bin/python`, `PATH=node26_env/bin:$PATH`,
`PYTHONPATH=<cv2h>` (OpenCV 4.13.0 headless), `SCORE_NOTAIL=1`.

### Phase U — bench inputs for the six (≈2.5 h, unattended)
1. U1 `bmimica_retrack_all.py --workers 16` → `retracked/` (30 camera-sessions, ~1–1.5 h).
2. U2 `bmimica_build_gt.py` → `gt/`. Check inliers/residual for the six against the 50.
3. U3 `bmimica_build_master.py` (back up the tsv first) → 56 rows.
4. U4 `bmimica_build_inputs.py` → `det_h5/` (~2 min).
5. U5 `fig6_sleap_max2_retrack.py` + `--verify` (sleap-nn 0.3.0) → `retracked_max2/` (~1.5 h).
   Runs alongside U6.
6. U6 `fig6_bytetrack_max2.py --stage track` (B1 never-retire, tail-free).

3D-MuPPET, liezl_c6 and the other U7 baselines are not in the manuscript, so they are not
rerun. `fig7_variant_best` keeps their 50-session keys only as internal fields, and they
are marked as such.

### Phase F2 — Fig 2C, E–G (FULL rerun, ≈6 h, quiet machine for the timed parts)
These draw a pooled keypoint sample across sessions, and the Anipose arm changes OpenCV
version, so they cannot be appended to.
1. `fig2_solvers_export.py --stride 15` → `out/fig4_input_md56.{json,bin}`. Make it fail
   loudly on a missing calibration.
2. `fig2_solvers_measure.mjs` → `fig4_md56.json` (~2.3 h).
3. `fig2_solvers_by_views.mjs`: shards including `50:56`, then `--merge` →
   `fig4_by_views_md56.json`.
4. `fig2_solvers_anipose.py` in `anipose072_cv413` → `fig4_anipose_md56.json` (~2.2 h).
5. `fig2_solvers_robust_sessions.mjs` → gated against `fig4_md56.json`.
6. Fig 2G timing, quiet machine, Node 26: `fig2g_retime_all.py --rounds 3` and
   `fig2_anipose_optim_retime.py`. Five rounds, as the Methods says, or the Methods is
   changed to match.
7. Redo the "0.13%" every-frame vs every-15th check (Methods line 271) on 56 with a small
   script, now deposited.

### Phase F3 — Fig 3E–H (append the six, ≈3 h)
1. `fig3_headtohead.py` (`HH_JOBS=16`, quiet) with the md56 cache. Exhaustive + greedy for
   the six only. Fig 3F timings: re-time two of the old sessions in the same sitting and
   require them to match their deposited times within 10%. If they don't, re-time all 98.
2. `fig3_quality.py`, then `fig3_hh_freshanchor.py --run`.
3. `fig3_sweep50.py`, fresh arm and shipped arm (shipped pinned to distanceThreshold 50) —
   144 new runs.
4. `fig3_exhaustive_bmimica.py`: hard-coded 50 (L62) becomes 56.
5. `fig3_frame_matched.py` from the fresh-anchor cache (see the tracker decision above).

### Phase F6 — Supp Fig 6 + camera subsets + fresh-anchor text (append the six, ≈3 h)
1. `fig6_methods.py --all-sessions` (configs as in `run_mousedyad.sh`; `shipped` pinned).
   Then `fig6_report50.py` and `fig6_pr_curve.py`.
2. `fig6_sleap_scoped.py` on `retracked_max2`, `fig6_bytetrack_max2.py --stage score`,
   `fig6_fair_baselines.py` (L71 gate 50 → 56).
3. `fig2_cams_identity.py --stage track` then `--stage score`. The session list (L56)
   moves to the md56 cache. The k = 5 gate runs after step 1.
4. Rebuild `fig7_variant_best_md56.json` with a committed script instead of by hand.

### Phase B — build the b figures (≈1 h)
`FIG_VARIANT=md56 FIG_TAG=b python3 figs/make_figures.py 2 3 6`, then `fig3_sync.py` and
`fig6_sync.py` for the composites. Output: `figures/fig2b/`, `figures/fig3b/`,
`figures/fig6b/`.

Deliverable for review: `MOUSEDYAD-56-NUMBERS.md`, with every number the text quotes
shown as before → after (50 → 56), plus the version table.

### Phase T — after approval only
1. Install the md56 deposits over the base names (back up first) and rebuild the figures
   unchanged.
2. Tex edits:
   - Session counts: 135, 146, 157 (92 → 98), 150, 241, 269, 271, 285, 289, 293, 301,
     407, 415, 485.
   - Every number those lines quote.
   - Line 241's paragraph about the subset is deleted. The corpus is simply 56 sessions,
     with the 09-08 sessions using the 09-04 rig calibration, stated once.
   - Line 301: OpenCV 4.13.0 for aniposelib.
   - Line 236: the motmetrics version.
3. Retire `fig5_benchmark_subset.py` and `data/fig5/fig5s_benchmark50_subset.csv`.
4. Fix the hard-coded "50" strings in `panels/fig6_07_pr_switches.py`,
   `panels/fig6_05_within_vs_cross.py`, `fig6_muppet_reid.py` and DATA-LOCATIONS.md
   (`luc3d_dump3d` says 56 but holds 50).
5. Fig 1A (`fig1_bmimica_scene.py`) is left alone unless Eric wants it. A larger pool
   could move the chosen frame.

## Time

U ≈ 2.5 h → F2 ≈ 6 h (can start right away, alongside U, except its timed steps) → F3 ≈
3 h → F6 ≈ 3 h (overlaps F3 apart from the timed steps) → B ≈ 1 h.
**About 12–14 h wall-clock to the b figures.** The timed steps (Fig 2G, Fig 3F) run alone.

## Status and decisions during the run (2026-10-14)

- Tracker choice (Eric): the current tracker everywhere. The only exception is the labelled
  "previous default" arm (Fig 3G/H sweep, Supp Fig 6F), which is pinned explicitly to
  distanceThreshold 50 with no eviction. The pin reproduces the cached cell bit for bit.
- Code version. All timing is measured on origin/main 2dc001fe (`/root/vast/eric/lucid-main-md56`)
  under Node 26.
  - Tracker output on one full session is bit-identical between main and eric/figs.
  - Exhaustive groupings are identical on 13,450 of 13,450 frames. The only difference is a
    global 0↔1 relabel, which the scores ignore.
  - Speed is not the same: main is 3.4× faster for the tracker and 2× for exhaustive. So
    accuracy can be appended, and every timing is re-measured.
- Fig 3F: both arms are now timed in the same head-to-head pass on main, 98 sessions, at 16 jobs.
  Before, exhaustive was a 50-session mean at 16 jobs while LUC3D was one session's first
  3,000 frames run alone.
- Fixed along the way:
  - `fig2_solvers_anipose.py` called a renamed file, `fig4_time_luc3d.mjs`.
  - `fig2_solvers_robust_sessions.mjs` ignored `POSE_DIR`.
  - Fig 2 hooks lacked main's new UI exports.
  - Versions are now recorded in the deposits: OpenCV in the anipose and retime outputs; the
    pin in the params.

## Tex audit checklist (from MD56-NUMBER-MAP.md)
- L150 mixes trackers in one sentence. With md56 the frame-matched greedy uses the current
  tracker. The "every non-zero ratio does better" claim compares different denominators
  (~22 M vs ~45 M camera frames), so reword it or show it frame-matched.
- L148 says "on identical detections". After Q this is true for both arms; update 3F's
  numbers and their wording.
- "1.2 mm" is used for two quantities: L103/L128 is Fig 2C (k=5 solve) and L130 is the Fig 2D
  floor. Reconcile them.
- L241: delete the 50/56 paragraph and state the 09-08 calibration once.
- L301: aniposelib 0.7.2 with OpenCV 4.13.0. L236: add the motmetrics version (1.4.0).
  Check Blender 5.0 vs 5.2 (L354).
- `data/fig2/fig2s1_cams_identity.csv` is stale (pre-tail-free); the b build regenerates it.
- The text's P values come from `scipy.stats.wilcoxon` on all raw differences, not from
  `fig6_report50.py`. Recompute them the same way.
