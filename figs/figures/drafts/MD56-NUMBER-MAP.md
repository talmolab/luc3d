# MD56 number provenance map (2026-10-14)

This map covers every number in `luc3d_newest.tex` that depends on one of three things: a Mouse-Dyad-10M analysis (50 → 56 sessions), a timing measurement (being re-timed on origin/main 2dc001fe, Node 26), or a software version.

**How to use it:** for each row, apply the recipe to `figs/out/<stem>_md56.json` in place of `figs/out/<stem>.json`. The base deposits are the tail-free bvis5nt run.

**Status:** every value was read from the current base deposit and compared with the tex.
- MATCH means the deposit value rounds to the quoted text.
- COMPUTED means no field holds the number, so it was recomputed here.
- UNRECORDED means the deposit does not store the value.

**How the numbers were checked:** with python3 json reads of `figs/out`, plus scipy (`liezl_env`) for the Wilcoxon tests. Paths are relative to `figs/out/` unless they start with `data/`.

**Abbreviations:**
- **MD** = Mouse-Dyad-10M.
- **"fresh"** = `__distanceThreshold25-stale20-sync_e508a7ab`, the post-PR#210 tracker: sync, stale 20, distanceThreshold 25, corr3d 6.
- **"4-config loop"** = `for c in configs: for ps in c.per_session: g = ps.gt[field]`, skipping sessions where `g.frames == 0`.

---

## 1. Figure 2 and triangulation

| L | quoted snippet | panel | source | recipe | value now | status | md56 effect |
|---|---|---|---|---|---|---|---|
| 103 | "a median of 1.2~mm" (5 cams) | 2C | fig4_by_views.json | `err3d_mm_across_sessions["5"]["dlt"]["p50"]` | 1.1945 | MATCH | 50→56 |
| 103 | "800 to 4,494 frames per second" | 2G (derived) | fig2g_retime_all.json | fps = 1e6 / (`best_us_per_keypoint.X` × 30), where 30 = 2 animals × 15 nodes. Low end X = `luc3d_refined`, high end X = `luc3d_dlt`. The formula is in MANUSCRIPT-REVISION-CHECKLIST-round1 L159. | 800.0 / 4,494.2 | MATCH (derived) | re-time |
| 126 | "from 75 per animal to 32" | 2B | fig2.json (already 56) → data/fig2/fig2b_placements_vs_rig.csv | 75 = 5 × 15. aided = 30 + 45 × (1 − median(`per_session[].held_out_vs_observation.acc10`)) | 75 / 32.45 | MATCH | none unless fig2.json is regenerated |
| 126 | "2.3x reduction" | 2B | same | 75 / aided_tau10 | 2.311 | MATCH | none |
| 126 | "48 placements per animal, 36\% fewer" | 2B | same | 30 + 45 × (1 − median(`acc5`)); then 1 − x/75 | 47.69; 36.4% | MATCH | none |
| 126, 135 | "10 pixels" / "$\sim$5 pixels" | 2B | panels/fig2_02_placements_vs_rig.py | constants `TAU_MAIN = 10`, `TAU_STRICT = 5` | 10 / 5 | MATCH (setting) | none |
| 128 | "two views is a median 4.74~mm" | 2C | fig4_by_views.json | `err3d_mm_across_sessions["2"]["dlt"]["p50"]` | 4.7382 | MATCH | 50→56 |
| 128 | "five-view solve is 1.19~mm" | 2C | fig4_by_views.json | `["5"]["dlt"]["p50"]` | 1.1945 | MATCH | 50→56 |
| 130 | "13 degrees gives 12.6~mm" | 2D | fig2.json (56) → data/fig2/fig2d_baseline_angle.csv | per pair in `per_session[].err3d_mm_by_pair`: median(`baseline_deg`) and median(`p50`); take the smallest-angle pair (1-2) | 13.46° / 12.60 mm | MATCH | none |
| 130 | "widest at 31 degrees gives 2.7~mm" | 2D | same | the largest-angle pair (0-1) | 31.49° / 2.676 mm | MATCH | none |
| 130 | "floor when all five views contribute is 1.2 mm" | 2D | fig2.json | median(`per_session[].err3d_mm_by_anchor_count["5"]["p50"]`) | 1.2074 (56 sessions, every frame) | MATCH | none. This is not the same quantity as 2C's 1.19; see §5 |
| 130 | "4.32 pixels … to 3.34 pixels with four" | 2E top | fig4_by_views.json | `heldout_px_across_sessions["2"/"4"]["dlt"]["p50"]` | 4.3189 / 3.3355 | MATCH | 50→56 |
| 135 | "band of $\pm$25\%" | 2D | panels/fig2_04_baseline_angle.py | `BAND = 0.25` | 0.25 | MATCH (setting) | none |
| 135 | "lowest error in all 50 sessions" | 2F | fig4.json `per_session[].reproj_p50`; fig4_anipose.json `per_session[].linear_reproj_p50` and `per_session_optim[].optim_nosmooth_reproj_p50` (→ data/fig2/fig2f_per_session.csv) | count of sessions where refined < min(other three) | 50/50 | MATCH | becomes "all 56" if it still holds |
| 135 | "same 200,000 keypoints (345,000 for the Anipose optimizing solver" | 2G | fig2g_retime_all.json | `n_linear`, `n_optim` | 200000 / 345000 | MATCH | re-time (check n_optim) |
| 135 | "B and D on all sessions and C and E to G on a subset" | 2B–G | fig2.json `n_sessions` = 56; fig4*.json `n_sessions` = 50 | — | 56 / 50 | MATCH | delete "on a subset" |
| 142 | "ranges from 2.15 to 2.35~pixels" | 2F | data/fig2/fig2f_per_session.csv (sources as for "all 50 sessions") | median across sessions of reproj_p50 for each solver; quote min and max (refined 2.1521, anipose_optim 2.2560, anipose 2.2646, dlt 2.3482) | 2.15–2.35 | MATCH | 50→56 and the OpenCV 4.13 env |
| 142, 198 | "3.8 … times faster" (linear) | 2G | fig2g_retime_all.json | `speedup_dlt_vs_anipose_linear` | 3.7736 | MATCH | re-time |
| 142 | "3.3 times faster" (refined) | 2G | fig2g_retime_all.json | `speedup_refined_vs_anipose_optim_nosmooth` (the `_default` variant gives 3.330) | 3.3437 | MATCH | re-time |
| 142, 198 | "7.4~$\mu$s per keypoint" | 2G | fig2g_retime_all.json | `best_us_per_keypoint.luc3d_dlt` | 7.417 | MATCH | re-time |
| 269 | "every 15th frame across the same 50 sessions" | 2E–G | fig4.json / fig4_input.json | `stride`, `n_sessions` | 15 / 50 | MATCH | 50→56. `fig4_input_md56.json` already exists: 56 sessions, 19,079,133 keypoints, stride 15 |
| 271 | "same 50 sessions and agreed to within 0.13\%" | 2C check | **no deposit** | COMPUTED: for k = 2..5, (median over sessions of fig2.json `err3d_mm_by_anchor_count[k].p50` restricted to the 50) vs fig4_by_views `err3d_mm_across_sessions[k].dlt.p50`, as a relative difference | −0.125, −0.010, −0.015, −0.130% → max 0.13% | MATCH (COMPUTED) | needs a small new script on 56, and the result should be deposited (plan F2.7) |
| 271 | "0.1 s intervals" | — | arithmetic | 15 / 150 | 0.1 | MATCH | none |
| 299 | "small but consistent decrease" (worst view dropped) | 2E bottom | fig4_robust_sessions.json → data/fig2/fig2e_worst_camera.csv | count of sessions with worst_dropped < all_views | 50/50 (both solvers); mean 2.056 → 1.711 px | MATCH | 50→56 |
| 301 | "aniposelib 0.7.2" | 2F/G | fig4_anipose.json `aniposelib_version`; fig2g_retime_all.json `aniposelib` | — | 0.7.2 | MATCH | keep |
| 301 | "outlier-rejection mode was 75 times slower" | 2G | fig2g_retime_all.json | `ransac_over_linear` | 75.20 | MATCH | re-time |
| 301 | "higher held-out error than its own linear solve in all 50 sessions" | 2F/G | fig4_anipose.json | count of `per_session_optim[]` where `optim_heldout_p50` > `linear_heldout_p50` | 50/50 | MATCH | becomes "all 56" if it still holds |
| 303 | "0.44 microseconds … aniposelib and 1.31 for this work" | 2G | fig2g_retime_all.json | `best_us_per_keypoint.anipose_undistort`, `.luc3d_undistort` | 0.4358 / 1.3110 | MATCH | re-time |
| 303 | "single thread … over five rounds … best round" | 2G | fig2g_retime_all.json | `rounds`, `numba_threads`; best = min(`runs_us_per_keypoint.X`) | rounds 5, numba_threads 1 | MATCH | the script default is `--rounds 3` (see §6) |
| 305 | "median reprojection error 2.40 pixels" | 2C ref | fig4.json | `reference_reproj_px.p50` | 2.4041 | MATCH | 50→56 |
| 305 | "use all 15 nodes, including the tail" | Fig 2 | fig2.json, fig4_anipose `per_session_optim[].n_joints` | — | 15 | MATCH | none |

## 2. Figure 3 and association

Sources for Fig 3E (as read by `panels/fig3_04_quality.py`):
- **Exhaustive** = `fig3_quality.json`, field `exhaustive`.
- **Greedy** = `fig3_quality__…e508a7ab.json` (fresh), field `greedy`.
- The base file's `greedy` field is the old default (52 perfect sessions, 0.0256%) and is **not** quoted.

| L | quoted snippet | panel | source | recipe | value now | status | md56 effect |
|---|---|---|---|---|---|---|---|
| 103 | "947 to 2,461 frames per second" | 3F LUC3D | fig3_runtime.json (→ data/fig3/fig3e_head_to_head.csv `luc3d_s`) | 1/max and 1/min of `luc3d_s` over the 5 plotted configs. Max = `measured[c6,a4]` 1.05633 ms (SLAP). Min = `measured[c5,a2,20250827_141755]` 0.40633 ms (MD). The 2×2 SLAP cell (4,559 fps) is not plotted. | 946.7 / 2461.0 | MATCH | re-time (`fig3_scale_runtime.py` is **not in the plan**; see §6) |
| 103 | "below one per 100,000 camera frames" | 3G r=6 | fig3_sweep50__…e508a7ab.json | `cells[corr3d==6].switches_per_100k_camera_frames` | 0.775 | MATCH | 50→56 |
| 103 | "mean cross-view IDF1 of 0.865 on Mouse-Dyad-10M" | 3H / S6A | the same file `cells[corr3d==6].idf1_cross`; also fig8_methods_50.json `cells[sync_stale20_dist25].idf1_cross` | — | 0.86512 | MATCH | 50→56 |
| 144 | "32 hypotheses … $\sim$190 million" | 3B | arithmetic | (2!)^5; (4!)^6 = 191,102,976 | — | MATCH | none |
| 144, 285 | "$\sim$4.7 million of the $\sim$9.7 million" | 3E/F | fig3_headtohead.json | Σ `configs[].frames_clean` / Σ `configs[].frames_considered`. The MD part (A2_C5) is 4,324,469 / 9,004,392. | 4,694,160 / 9,678,503 | MATCH | MD+SLAP; MD part grows (~10.8 M total expected) |
| 146, 157, 243, 285 | "92 sessions" = "50 … and the 42" | 3E/F | fig3_headtohead.json, fig3_quality.json | `n_sessions`; per config: A2_C5_bmimica 50 + A2_C6 35 + A3_C5 4 + A4_C3 3 | 92 = 50 + 42 | MATCH | 98 = 56 + 42 |
| 146, 157, 285, 287 | "$\sim$4.6 million frames" | 3E | fig3_headtohead.json | `frames_compared` (= Σ `frames_computed`). GT-scored Σ `gt.*.frames` = 4,646,417. | 4,646,644 | MATCH | MD+SLAP |
| 146 | "every frame correctly in 63 of 92" | 3E greedy | fig3_quality__…e508a7ab.json | 4-config loop, field `greedy`; count `exact_match_frames == frames`. Split is MD 46 + SLAP 17. | 63 | MATCH | MD part moves |
| 146 | "exhaustive enumeration in 51" | 3E | fig3_quality.json | same loop, field `exhaustive`. Split is MD 47 + SLAP 4. | 51 | MATCH | MD part moves |
| 146 | "misgrouped 0.023\%" | 3E | fresh quality file | 100·Σ(frames − exact_match_frames)/Σ frames, field `greedy`, all sessions | 0.02251% | MATCH | pooled |
| 146 | "exhaustive enumeration 0.040\%" | 3E | fig3_quality.json | same, field `exhaustive` | 0.04048% | MATCH | pooled |
| 146 | "four animals and three cameras … 0\% … 0.80\%" | 3E | both quality files, config `A4_C3_slap2m` | median over 3 sessions of the per-session rate | 0.0 / 0.80% | MATCH | SLAP-only, no change |
| 157 | "Both methods have a median of 0\%" | 3E | both | median of all per-session rates | 0 / 0 | MATCH | recheck |
| 157 | "up to 5.2\% … and 3.1\%" | 3E | both | max per-session rate. Both maxima are A2_C6 (SLAP); the MD maxima are 0.565% (exh) and 0.588% (greedy). | 5.218 / 3.072 | MATCH | changes only if a new MD session exceeds them |
| 157, 285 | "2,000 per session … 1,000" | 3E | fig3_headtohead.json | `caps.clean_frames_per_session.A3_C5_slap2m` / `A4_C3_slap2m` | 2000 / 1000 | MATCH (setting) | none |
| 148 | "16 times at two animals in five cameras" | 3F | fig3_headtohead.json + fig3_runtime.json | `configs[A2_C5].seconds_per_frame_exhaustive` / `measured[c5,a2,BMimica].seconds_per_frame` | 15.95 | MATCH | re-time |
| 148, 285 | "6.5 ms per frame" / "6.5 to 12~ms" | 3F | fig3_headtohead.json | `configs[A2_C5].seconds_per_frame_exhaustive` (= `exhaustive_wall_seconds` / `frames_computed` = 28031.79 / 4,324,469); `configs[A2_C6]…` | 6.48 ms (MD) / 12.15 ms (SLAP) | MATCH | re-time |
| 148, 200 | "greedy method 0.4 ms" / "0.4 to 1.1~ms" | 3F | fig3_runtime.json | as for the fps row | 0.406 / 1.056 ms | MATCH | re-time |
| 148 | "four animals in six cameras … 1.1 ms" | 3F | fig3_runtime.json `measured[c6,a4]` | — | 1.056 ms | MATCH | SLAP, re-time |
| 148 | "more than 12 hours" | 3F open marker | data/fig3/fig3e_head_to_head.csv row 4×6 `exhaustive_lo_s`; `panels/fig3_06_head_to_head.py build()` | rate_lo = min over measured configs of `exhaustive_s/hypotheses` (now A2_C6: 12.1498 ms / 64 = 189.8 µs). Then × (4!)^6/(4!) = 7,962,624 → 1,511.6 s/frame; × 30 / 3600 | 12.6 h | MATCH | moves to MD only if the new A2_C5 is < 6.075 ms/frame |
| 200 | "over an order of magnitude faster" | 3F | as above | ratio ≥ 10 at every config | 16×–6,200× | MATCH | recheck |
| 285 | "2.1 and 4.3~s per frame" | 3F | fig3_headtohead.json `configs[A3_C5/A4_C3].seconds_per_frame_exhaustive` | — | 2.072 / 4.322 s | MATCH | SLAP, re-time |
| 148, 285 | "$10^6$ hypothesis cap" | 3B/F | fig3_headtohead.json `caps.max_hypotheses_per_frame` | — | 1e6 | MATCH (setting) | none |
| 150, 289 | "from 0 to 24" / "twelve values of r" | 3G/H | sweep50 files `grid_corr3d` (len 12) | — | [0 … 24] | MATCH | none |
| 150, 157, 289 | "50 benchmark … sessions" | 3G/H | sweep50 `len(sessions)`, `cells[].n_sessions` | — | 50 | MATCH | 56 |
| 150 | "91 times per 100,000 … IDF1 of 0.651" | 3G/H exh. ref | fig3_frame_matched_bmimica.json | `arms.exhaustive.switches_per_100k_camera_frames`, `arms.exhaustive.idf1_cross_mean`. **Do not** use `fig3_exhaustive_bmimica.json idf1_cross_mean` (0.414, whole-session scoring). | 91.44 / 0.6513 | MATCH | 50→56 |
| 150 | "$r = 0$ … 533 switches … 0.618" | 3G/H | fresh sweep50 `cells[corr3d==0]` | — | 533.28 / 0.6184 | MATCH | 50→56 |
| 150 | "Every non-zero ratio … does better" | 3G/H | fresh sweep vs frame-matched exhaustive | every cell with corr3d > 0 has per-100k < 91.44 and IDF1 > 0.651 (the worst is r = 0.25: 3.35 / 0.776) | true | MATCH | recheck |
| 150 | "$r = 6$, gives 0.78 … 0.865" | 3G/H | fresh sweep50 `cells[corr3d==6]` | — | 0.7752 / 0.8651 | MATCH | 50→56 |
| 150 | "ratio to 12 lowers this to 0.70 with almost no change" | 3G/H | fresh sweep50 `cells[corr3d==12]` | — | 0.6952 / 0.8657 | MATCH | 50→56 |
| 150, 289 | "about 22 million of the 45 million camera frames" | 3G | fig3_exhaustive_bmimica.json `camera_frames_computed`; sweep50 `total_camera_frames` | — | 21,622,345 / 45,021,960 | MATCH | about 24 M / 50.4 M expected |
| 150 | "8.1 times per 100,000 … IDF1 of 0.800" | 3G/H frame-matched | fig3_frame_matched_bmimica.json (= data/fig3/fig3d_frame_matched_rules.csv) | `arms.greedy.switches_per_100k_camera_frames`, `arms.greedy.idf1_cross_mean` | 8.075 / 0.7998 | MATCH. **This is the pre-#210 tracker** (§5) | recompute from the fresh-anchor cache |
| 150 | "eleven times fewer switches" | 3G | same | 91.442 / 8.075 | 11.32 | MATCH | recompute |

## 3. Supplementary Figure 6, camera subsets, eviction

Arms in `fig8_methods_50.json` `cells[]`:
- **No eviction** = `shipped`.
- **N = 1 / 10 / 20 / 30** = `sync_stale{1,10,20,30}_dist25`.
- **Best re-tune without eviction** = `dist25_corr36`.

Win counts use **strict** signs (`vs_shipped.sessions_higher/lower_cross_idf1`). P values use `scipy.stats.wilcoxon(d)` on all 50 raw differences (two-sided, default `zero_method`). **Do not** use `fig6_report50.py`'s counts or P values: it applies a 1e-4 tolerance and drops |d| ≤ 1e-9, which gives 34/4, 31, P = 5.3e-8 and 7.0e-6.

| L | quoted snippet | panel | source | recipe | value now | status | md56 effect |
|---|---|---|---|---|---|---|---|
| 411 | "0.865 within view and 0.865 across" | S6A | fig7_variant_best.json | `bmimica_50_sessions["LUC3D"].within.mean` / `.cross.mean` (must equal fig8 `sync_stale20_dist25`) | 0.86499 / 0.86512 | MATCH | rebuild variant_best with a script (it is hand-built today) |
| 411, 103 | "SLEAP 0.659 to 0.149" | S6A | fig7_fair_baselines.json | `arms["SLEAP per-camera (2 tracks enforced)"].within.mean` / `.cross.mean` | 0.65858 / 0.14851 | MATCH | 50→56 (6 sessions need the sleap-nn 0.3.0 env) |
| 411 | "ByteTrack 0.754 to 0.177" | S6A | fig7_fair_baselines.json | `arms["ByteTrack (2 identities, B1s)"]…` | 0.75387 / 0.17681 | MATCH | 50→56 |
| 411 | "about 23\%" | S6A | data/fig6/fig6a_within_vs_cross_variant.csv `ratio` | cross / within | 0.2255 / 0.2345 | MATCH | recompute |
| 407, 485 | "uses the 50 Mouse-Dyad-10M sessions" / "A, 50 …" | S6A | fig7_fair_baselines `arms.*.n_sessions` | — | 50 | MATCH | 56 |
| 204, 293 | "0.68 … 0.86" / "0.68, 0.78, 0.83 and 0.86" | cam subsets | fig2_cams_identity.json | mean of `per_run[].within_idf1` where `subset` starts with `k{k}` (= mean of the 3 `summary[...].within_idf1_mean`) | 0.6847, 0.7786, 0.8257, 0.8650 | MATCH | 50→56 |
| 293 | "from 2,259 to 3,385 … to 349 with all five" | cam subsets | fig2_cams_identity.json | min/max of `summary[k2_*].within_switches_total`; `summary.k5_full.within_switches_total` | 2259 / 3385 (third subset 2330) / 349 | MATCH | 50→56 |
| 293 | "three fixed subsets" | cam subsets | `subsets` keys per k | — | 3/3/3 + k5_full | MATCH | none |
| 293 | "reproduces the main 50-session result exactly" | cam subsets | `gate.passed`, `gate.max_abs_diff_idf1`, `gate.reference` | — | True; 0.0; ref fig8 sync_stale20_dist25 | MATCH | "56-session" |
| 293 | "over the same 50 sessions" | cam subsets | `summary.*.n_sessions` | — | 50 | MATCH | 56 |
| 345 | "$N$ was swept over 1, 10, 20 and 30" | S6F | fig8 `cells[].config` | — | present | MATCH | none |
| 345 | "reduced from 50 to 25~mm" | S6F | fig8 `overrides.thresholds.distanceThreshold` = 25. `shipped` has `overrides = {}`; the 50 appears only in comments in fig6_methods.py L95–100 and scripts/bench/hooks.mjs | — | 25 recorded; 50 UNRECORDED | MATCH / UNRECORDED | md56 pins 50 explicitly |
| 347, 415, 485 | "50 benchmark … sessions" / "across the 50 sessions" | S6F | fig8 `len(sessions)` | — | 50 | MATCH | 56 |
| 485 | "F, … $\sim$45 million camera frames" | S6F | fig8 `total_camera_frames` | — | 45,021,960 | MATCH | about 50.4 M |
| 415 | "fell from 1,917 to 349" | S6F | fig8 `cells[shipped / sync_stale20_dist25].switches` | — | 1917 / 349 | MATCH | 50→56 |
| 415 | "(0.0043\% to 0.0008\% of camera frames)" | S6F | switches / total_camera_frames × 100 | — | 0.004258 / 0.000775 | MATCH | recompute |
| 415 | "rose from 0.759 to 0.865" | S6F | `cells[...].idf1_cross` | — | 0.75889 / 0.86512 | MATCH | recompute |
| 415 | "median session improved from 0.769 to 0.917" | S6F | median of `per_session[].cross_idf1` | — | 0.76907 / 0.91659 | MATCH | recompute |
| 415 | "36 of 50 sessions improving and 10 worsening" | S6F | d = stale20 − shipped per session, strict sign; = `vs_shipped.sessions_higher/lower_cross_idf1` | — | 36 / 10 (4 ties) | MATCH | recompute "of 56" |
| 415 | "$P = 8.1 \times 10^{-7}$" | S6F | `wilcoxon(d)` | — | 8.11e-7 | MATCH | recompute |
| 415 | "improved by 0.097 … 34 of 50 … $P = 2.4 \times 10^{-5}$" | S6F | d = stale20 − dist25_corr36; median; strict count; wilcoxon | — | 0.0969; 34 (11 worse, 5 ties); 2.37e-5 | MATCH | recompute |
| 417 | "1,917 … 625 … 445 … 349 … 391" | S6F | `cells[cfg].switches` | — | as quoted | MATCH | recompute |
| 417 | "(0.759, 0.845, 0.855, 0.865 and 0.852)" | S6F | `cells[cfg].idf1_cross` | — | 0.7589, 0.8453, **0.854504**, 0.8651, 0.8523 | MATCH (the N=10 value is on the rounding edge) | recompute |
| 417 | "(0.769, 0.886, 0.913, 0.917 and 0.905)" | S6F | median of `per_session.cross_idf1` | — | 0.7691, **0.88551**, 0.9127, 0.9166, 0.9046 | MATCH (the N=1 value is on the rounding edge) | recompute |
| 417 | "$P = 0.27$, 0.86 and 0.20" | S6F | `wilcoxon(stale20 − stale{1,10,30})` | — | 0.2675, 0.8575, 0.2014 | MATCH | recompute |
| 417 | "349 versus 445 … 0.865 versus 0.855 and 0.917 versus 0.913" | S6F | as above | — | as quoted | MATCH | recompute |

## 4. Session, frame and dataset counts (MD)

| L | snippet | source | value | status | md56 action |
|---|---|---|---|---|---|
| 103, 113 | "56 sessions … 50.4 million video frames, 20.2 million 3D poses … 100.8 million 2D poses" | out/dataset_sheets.json `mousedyad10m` | 56; 50,423,670; 20,169,468; 100,847,340 | MATCH | none |
| 196 | "66 million video frames" | 50.4 + 15.6 | 66.0 | MATCH | none |
| 241 | "$\sim$10 million synchronized frames per view, $\sim$20 million 3D instances and $\sim$100 million 2D" | dataset_sheets.json | 10,084,734 / 20.17 M / 100.8 M | MATCH | none |
| 241 | "use the 50 sessions that were in the corpus … six sessions recorded on 8 September 2025 were added afterwards and enter Figures 2B and D and 5" | fig2.json 56 vs fig4*/fig3*/fig8* 50 | — | MATCH today | **delete** (plan T2) |
| 241 | "female starts 80.0\% … in the 50 sessions leads in all 32 that have a display" | fig5 deposits (not re-verified; out of scope) | — | — | delete with the paragraph |
| 241 | "Figures 2B to G, 3E to H, 5, and Supp 6A and F, were measured on this corpus" | — | — | ambiguous today | keep once everything is on 56 |
| 243, 146, 157, 285 | "42 multi-animal sessions" (SLAP) | §2 | 42 | MATCH | unchanged |
| 269 | "Behavioral analyses and tracking metrics … every frame" | — | — | — | none |
| 351 | "the 56 sessions are repeated recordings of nine mice" | — | — | — | none |
| 144, 285 / 150, 289, 485 | ~9.7 M, ~4.7 M, ~4.6 M / ~45 M, ~22 M | §2, §3 | — | MATCH | all MD-driven, all move |

## 5. Timing and versions not tied to MD (listed because of scope item b/c)

| L | snippet | source | value | status | note |
|---|---|---|---|---|---|
| 236 | "Node 26" | fig2g_retime_all.json `node` v26.10.0; fig4_anipose.json `timing.luc3d_recheck.node` v26.5.0; md56_logs v26.10.0; fig3_*, fig8_methods_50 and fig2_cams_identity record nothing | 26.x | MATCH (major version only) | md56 deposits should record `process.version` and the git commit |
| 236 | "Python 3.12 with NumPy …" | liezl_env 3.12.7; NumPy 2.4.6 (bench envs) / 2.5.1 (figure .venv) | — | MATCH from the env, UNRECORDED in deposits | — |
| 236, 555 (bib) | motmetrics (bib "v1.4.0") | liezl_env motmetrics 1.4.0; not in deposits | 1.4.0 | consistent, UNRECORDED | plan T2: add the version to L236 |
| 236, 301 | "comparison triangulation from aniposelib 0.7.2" | fig4_anipose `aniposelib_version`, fig2g_retime_all `aniposelib` | 0.7.2 | MATCH | — |
| 301 | "corrects for lens distortion with OpenCV" (no version) | the deposit env `anipose_env` = opencv-contrib **5.0.0.93**, not recorded in the deposit | 5.0.0 | **CONFLICT** in spirit with L433 "OpenCV 4.13.0". md56 uses `anipose072_cv413_env` (4.13.0.92); `fig2_solvers_anipose.py` L598 records cv2 from md56 on | state 4.13.0 at L301 |
| 236, 433, 473 | "comparison calibration from aniposelib 0.8.0"; "Both calibration tools ran on OpenCV 4.13.0"; OpenCV.js 4.13.0 | fig7_calibration.json `opencv` = "4.13.0 (both detectors)" | 4.13.0 | MATCH. aniposelib 0.8.0 is UNRECORDED in the deposit | not MD-56 dependent |
| 435, 447 | calibration time "idle 64-core machine"; "calibrat3 is faster than Anipose on the Mouse-Dyad-10M rig and slower on the other two" | fig7_calibration.json `datasets.{slap8,md10,calib18}.timing.anipose` (`detection_s_wall`, `calibration_s`; opencv_threads 8/12/3) | — | qualitative, not re-verified | calibrat3/Anipose timing, not LUC3D code. Decide whether "all timings re-measured" includes it; otherwise leave as is |
| 267, 337 | "sleap-nn 0.3.0" (MD) / "0.2.0" (SLAP) | sleap_nn_env = 0.2.0 (sleap-io 0.7.0); 0.3.0 is in the 50 .slp files per the plan; fig7_sleap_max2.json has no version field | — | 0.2.0 MATCH (env); 0.3.0 UNRECORDED in deposits | the six new sessions need a verified 0.3.0 env |
| 339 | ByteTrack (no version) | eks_env supervision 0.30.0; not in fig7_bytetrack_max2.json | 0.30.0 | UNRECORDED | consider adding the version to Methods |
| 354 | "Blender 5.2" | blender-images/cage_scene.py L22 docstring: "bpyenv/, Blender 5.0" | — | **possible CONFLICT** | check `bpy.app.version` |
| 439 | "SLEAP 1.2.8 … SLEAP 1.3.3" (training) | not found in deposits or figs docs (searched out/*.json, *.md) | — | UNRECORDED | — |
| 236 | Three.js, h5wasm, sleap-io.js (no versions given) | index.html three@0.147, h5wasm 0.10.3, sleap-io.js 0.5.5 (CLAUDE.md) | — | nothing to check | — |
| 457 | Panopticon "9.997 ms", "2.3 µs" jitter, "210 to 223 ppm", "15 ms" drift | acquisition timing, not compute speed | — | out of scope | not re-timed |

---

## 6. Flags

### 6a. Internal inconsistencies in the tex

1. **L150 mixes two trackers in one sentence.** "8.1 … at an IDF1 of 0.800, eleven times fewer" comes from `fig3_frame_matched_bmimica.json`'s greedy arm, which is the pre-PR#210 head-to-head arm. The arm records itself as "NOT the fresh-anchor operating point". The r = 6 numbers next to it (0.78 / 0.865) are the fresh-anchor tracker. Recompute the frame-matched rule from the fresh-anchor cache (`fig3_hh_freshanchor`), as plan F3.5 says.
2. **L148 says the Fig 3F times are on "identical detections", but the two methods are timed differently.**
   - Exhaustive time (6.5 ms) is the mean over 50 sessions, run under `HH_JOBS=16` concurrency.
   - LUC3D time (0.4 ms) comes from `fig3_runtime.json`: one session, the leading 3,000 frames, run alone.
   - The head-to-head deposit's own greedy time at 2×5 (median `per_session[].seconds_per_frame_greedy` = 1.53 ms) is 3.7× the quoted 0.406 ms.
   - The 16×, 0.4/1.1 ms and 947–2,461 fps all inherit this. Make them comparable in the re-time, or describe the protocol.
3. **"1.2 mm" means two different things.**
   - L103 and L128 (1.19) are Fig 2C: 50 sessions, every 15th frame, 1.1945.
   - L130's "floor … 1.2 mm" is Fig 2D: 56 sessions, every frame, 1.2074.
   - Both round to 1.2 today. After md56, check they still agree, or say which is meant.
4. **L241 is self-contradictory.** It says C and E–G, Fig 3 and Supp Fig 6 use the 50 sessions, and B, D and 5 use all 56. It then says "Figures 2B to G, 3E to H, 5 and Supp 6A and F were measured on this corpus". This resolves itself once the paragraph is deleted and everything is on 56.
5. **L135 caption and L269/L271/L301** say "all 50 sessions", "a subset" and "the same 50 sessions". These must all change together with L146/L157/L243/L285 (92 → 98, 50 → 56), L150/L289/L293/L347/L407/L415/L485.
6. **L150 compares rates over different denominators.** Exhaustive is over ~22 M clean camera frames, greedy over ~45 M. L289 discloses this, but "Every non-zero ratio … does better than exhaustive enumeration" is not frame-matched.
7. **L204 vs L411 rounding.** 0.86 (5 cameras, within-view) vs 0.865 is the same quantity rounded differently. That is fine, but keep both in sync after md56.
8. **The 12-hour bound (L148) is set by a SLAP config.** It uses the cheapest per-hypothesis rate, today A2_C6 at 189.8 µs. Re-timing any config can move it. It switches to the MD config only if the new A2_C5 is below 6.075 ms/frame.
9. **Deposit and docstring text is stale** (not tex, but it misleads a reader):
   - The `fig3_headtohead.json` caveat says "~3.9 s / ~7.8 s / ~8 ms" against the deposit values 2.07 / 4.32 s / 6.5 ms.
   - The `panels/fig3_06_head_to_head.py` docstring says "244 µs … 50 fps".
   - The fresh quality/headtohead `variant.notes` say panels don't read them, but Fig 3E greedy does.
   - `fig4_anipose.json` `per_session_optim_note` says "stride-60", but the stride is 15.
   - `fig2_cams_identity.py` L17 cites "2,071 switches".
   - The `fig7_bytetrack_max2.json` `why` field says 60 frames = 2 s (correct for SLAP, not MD).
10. **`data/fig2/fig2s1_cams_identity.csv` is stale (pre-tail-free).** It shows k2 3,540 / 2,538 / 2,383 and k5 413, within-view 0.861. The deposit and tex say 2,259–3,385 / 349 / 0.865. The tail-free note said the data CSVs were rebuilt, but this one was not. Regenerate it in the md56 build.
11. **`fig7_variant_best.json` is hand-built.** Its `SLEAP per-camera` and `ByteTrack` keys under `bmimica_50_sessions` hold old, invalid series (0.206/0.062 and 0.157/0.046). The text and panel A take them from `fig7_fair_baselines.json`. Rebuild it with a script (plan F6.4) and assert LUC3D == fig8 `sync_stale20_dist25`.
12. **`fig6_report50.py` disagrees with the tex** on win counts and P values, because of its tolerance and zero-drop rules (§3 header). Use the recipe here, or align the script.

### 6b. Code version and setting conflicts with what the deposits record

1. **Fig 2G timing code version.** `fig2g_retime_all.json` `pose_dir` = `/root/vast/eric/lucid-main-timing/pose`, a checkout at **1d672c12** (#228, 2026-09-22), not 2dc001fe. `fig4.json` `poseDir` = `lucid-bundle-adj/pose`, a different tree. So the accuracy and timing numbers in Fig 2 come from two code trees. Neither records a commit hash.
2. **Rounds.** L303 says "five rounds". The current deposit has `rounds: 5` (MATCH). But `fig2g_retime_all.py` defaults to `--rounds 3` and `NODE=node22_env`, and plan step F2.6 says `--rounds 3`. Run with `--rounds 5` and `NODE=node26_env/bin/node`, or change L303. `fig4_anipose_optim_retime.json` has `repeats: 3`, which is not quoted.
3. **Node patch versions are mixed.** v26.10.0 (retime, md56 logs) and v26.5.0 (fig4_anipose recheck). Most deposits (fig3_*, fig8_methods_50, fig2_cams_identity, fig4, fig4_by_views) record no Node version, commit or machine. The md56 deposits should record `process.version`, the git commit (2dc001fe), the host and HH_JOBS.
4. **OpenCV for the Anipose triangulation arm.** The current Fig 2F/G Anipose numbers ran on OpenCV **5.0.0.93** (`anipose_env`). L433 says the calibration comparison ran on 4.13.0, and L301 is silent. md56 moves the arm to 4.13.0.92 (`anipose072_cv413_env`). Add "OpenCV 4.13.0" at L301/L236, and confirm the new deposit records `cv2.__version__` and `numpy.__version__`.
5. **`fig3_scale_runtime.py` / `fig3_runtime.json` / `fig3_scale.json` are missing from the md56 plan.** Phase F3 re-times only `fig3_headtohead.py`. Without this step, 0.4/1.1 ms, 16×, 947–2,461 fps and the "0.4 to 1.1 ms" in L200 stay on old code (2026-10-09, tracker defaults at that date unrecorded).
6. **Pre-#210 "shipped" arms do not record their settings.** `fig8_methods_50` `shipped` (`overrides {}`) and `fig3_sweep50.json` (`cache_tag 'shipped'`, empty `base_method`/`base_thresholds`) do not record distanceThreshold 50 / no sync / no stale. L345's "from 50" and L415's "no eviction" are inferred from code comments. md56 `fig6_methods.py` pins `distanceThreshold: 50`; make sure the deposit writes it out.
7. **Exhaustive timing was measured under 16-way concurrency** (`HH_JOBS=16`), while the tex reads as single-process. Plan F3.1 re-times two old sessions in the same sitting and requires a 10% match. Record HH_JOBS in the deposit.
8. **Tracker settings.** `e508a7ab` = `{sync: true, stale: 20}` + `{distanceThreshold: 25}` with corr3d 6. This matches L283's defaults (w3D = 6, d3D = 25 mm, N = 20). `fig3_runtime.json` claims "default thresholds — what the app ships" without recording which defaults.
9. **Stride.** All Fig 2C/E–G deposits record stride 15, matching L269/L271/L301. fig2.json is stride 1 (every frame), matching L269 for 2B/D.
10. **Versions missing from the deposits:** motmetrics 1.4.0, supervision 0.30.0, sleap-nn 0.3.0, NumPy, aniposelib 0.8.0 (calibration), Blender (5.0 docstring vs 5.2 tex) and SLEAP 1.2.8/1.3.3 are not recorded in any deposit. Either deposit them with md56 or accept them as env-level facts.

### 6c. Lines to touch in the md56 tex pass (session counts and numbers)

- **Session counts and numbers:** 103, 126 (check only), 128, 130 (4.32/3.34), 135, 142, 144, 146, 148, 150, 157, 198, 200, 204, 241 (delete paragraph), 243, 269, 271, 285, 287, 289, 293, 301, 303, 305, 347, 407, 411, 415, 417, 485.
- **Versions:** 236 (motmetrics; OpenCV for aniposelib), 301 (OpenCV 4.13.0), 354 (Blender, verify).
