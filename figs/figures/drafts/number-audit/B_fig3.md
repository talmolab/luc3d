# B: Fig 3 audit (tex L140-160, Methods L273-293, L327-331, L349-351, repeats in L90-210)

Status: COMPLETE. Read-only; no files changed.

## Problems, most important first

1. **The placed Fig 3 was NOT built from the J17 timing. The tex quotes J17.**
   - `figures/fig3/fig3.pdf` and `data/fig3/*.csv` were last written 2026-10-20 03:27, before J17 finished at 16:55.
   - `data/fig3/fig3e_head_to_head.csv` holds the T1 sitting (`out/fig3_runtime_clean_b3.json` + `_a4c6`):
     - 2x5: greedy 0.2382 ms vs exhaustive 3.999 ms, 16.8x.
     - 4x6: greedy 0.6533 ms.
     - These are the old tex numbers (17x, 0.24, 0.65).
   - The J17 build (`FIG3F_CLEAN=1 FIG3F_CLEAN_TAG=_j17`, log `out/md56_logs/FIG3C_j17_make_figures.log`, loads `FIG3C_j17_loads.tsv`) went only to the **untracked** `figures/fig3c/fig3c.pdf` + `data/fig3c/` (16:57). It was never promoted to `figures/fig3/`.
   - `data/fig3c/fig3e_head_to_head.csv` = J17: 2x5 0.2819 vs 3.952 ms (14.0x), 4x6 0.7033 ms.
   - The plan log (`LUC3D-JS-CONSISTENCY-PLAN-2026-10-20.md` L134) itself says: "For the final build: Fig 3 needs FIG3F_CLEAN=1 FIG3F_CLEAN_TAG=_j17". That has not happened yet.
   - Fix: promote `figures/fig3c/fig3c.pdf` -> `figures/fig3/fig3.pdf` and `data/fig3c/fig3e_head_to_head.csv` -> `data/fig3/`, or rebuild main Fig 3 with the tag.
   - The visual difference in panel F is tiny, because the panel prints no numbers. Provenance is wrong all the same.
2. **`data/fig3` vs `data/fig3c`.** All six CSVs are byte-identical except `fig3e_head_to_head.csv` (T1 vs J17). So `data/fig3c/` is not a plain leftover. It is the newer, J17-correct copy.
3. **The J17 deposits carry `sitting.valid = false`.**
   - Affected: `fig3_runtime_clean_b3_j17.json` and `_j17_a4c6.json`.
   - Cause: `max_outside_cores` was 0.578, over the 0.5-core rule. That happened in 2 of ~950 five-second samples (VS Code server + Claude CLI) during part 1.
   - Part 2 on its own is valid (0.268, `J17_watch.jsonl` summary `valid: true`).
   - The tex says "No other process of ours ran during the timing, which was checked...". That is defensible but slightly generous. Eric should decide whether the Claude CLI counts as "ours".
4. **MISMATCH-METHOD (minor), Methods L285, "the bar on that marker spans two ways of counting the hypotheses".**
   - In `panels/fig3_06_head_to_head.py` the bar's two ends also use **different per-hypothesis rates**:
     - Low end: distinct count 7.96e6 x the fastest measured rate, 83.9 µs (2x6) = 668 s.
     - High end: full count 1.91e8 x the rate of the LARGEST measured config, 111 µs (4x3) = 21,221 s.
   - So the bar is not counting alone. Suggest: "two ways of counting ... and two measured per-hypothesis rates".
   - The lower-bound claim itself ("fastest per-hypothesis rate measured anywhere") is correct.
5. **MISMATCH-METHOD (minor), Methods L275, "On SLAP-2M the four tail nodes were given zero weight, so the association relies on the 11 body nodes".**
   - The SLAP-2M greedy runs used weight 0 with `tailNan: False` (e.g. `out/tmp/headtohead_b3/A2_C6_slap2m/*/greedy.json`).
   - `fig3-bench/fig3_bench.mjs` L62-63 notes that target creation (`epipolarErrorMatrix`) ignores nodeWeights.
   - So tail keypoints still enter target births and the target triangulation. Only the matching cost excludes them.
   - The wording is accurate for the Hungarian cost but not for "the association" as a whole.
6. **Definitions in Results L150 (wording, not numbers).**
   - "An identity switch is a detection given the identity of a different animal than in the ground truth": the scored quantity is the motmetrics ID switch (a change in a GT track's matched ID over time), summed over cameras within each view (`switches` = within-view sum). The sentence describes a mismatch or an IDF1 error instead.
   - The IDF1 values quoted (0.847, 0.748, 0.969) are **means over sessions** of the per-session cross-view IDF1 (`idf1_cross_mean`; the exhaustive median is 0.860). The text does not say "mean".
7. **Exhaustive per-frame times in Methods L285 come from the J17 timing sitting, not the enumeration run.**
   - Tex: "0.87 and 1.5 s per frame ... two-animal configurations took 4.0 to 5.4 ms".
   - J17 timing: 0.873 s, 1.535 s, 3.95 ms, 5.37 ms. Matches the tex.
   - The enumeration run that actually drove the sampling decision (`fig3_headtohead_b3.json` `seconds_per_frame_exhaustive`): 0.885 s, 1.543 s, 3.89-5.41 ms, which is 0.88-0.89 / 1.5 s / 3.9-5.4 ms.
   - ROUNDING-level. It is acceptable if the timing sitting is the intended source.
8. **Stale caveat text inside deposits (metadata only; numbers are right).**
   - `fig3_quality_b3.json` and `fig3_headtohead_b3.json` caveats say "50 BMimica sessions". The data hold 56.
   - The sweep deposit caveat names driver `fig6_bench.mjs`/`xv_experimental.js`, but the `driver` field is `fig3_bench.mjs`.
   - Not a tex problem. It would mislead a reviewer of the deposits.
9. **UNVERIFIABLE, Methods L285, "start-up compilation roughly doubles its cost per frame on the 100-frame runs".** No deposit field or log isolates start-up cost. I searched the J17 runtime/headtohead deposits and the `J17_*` logs.

Everything else checked is OK (table below).

## Claims table
| tex line | claim | source file:field | value found | verdict | note |
|---|---|---|---|---|---|
| 142 | median reproj error 2.15-2.34 px | data/fig2/fig2f_per_session.csv reproj_p50 medians | refined 2.146, anipose_optim 2.247, anipose 2.256, dlt 2.340 | OK | Fig 2 (subsec 2-3), checked briefly |
| 142 | linear / refined 32x and 4.9x faster | data/fig2/fig2g_time_per_keypoint.csv | 28.586/0.885=32.3; 134.27/27.45=4.89 | OK | |
| 142 | 11x incl. undistortion | same + Methods L303 (0.4 and 1.7 µs) | (28.59+0.4)/(0.885+1.7)=11.2 | OK | aniposelib undistortion is from an earlier sitting (the tex says so) |
| 142,198 | 0.89 µs per keypoint | fig2g csv DLT | 0.885 | OK | |
| 144 | (A!)^C: 32 at 2x5; ~190 million at 4x6 | arithmetic; data/fig3/fig3b_cost_model.csv | 32; 191,102,976 | OK | |
| 144 | exhaustive run on ~10.1M of ~10.8M frames | out/fig3_headtohead_b3.json configs frames_clean / frames_considered | 10,108,398 / 10,758,845 | OK | |
| 146 | 98 sessions = 56 MD + 42 SLAP | headtohead_b3 n_sessions | 56 + 35 + 4 + 3 | OK | |
| 146 | ~10.1M frames scored by both | out/fig3_quality_b3.json per_session gt frames | 10,060,322 | OK | |
| 146 | every frame correct in 23 of 98 (greedy), 15 (exhaustive) | fig3_quality_b3.json per_session gt (frames - exact_match_frames == 0) | 23 / 15 | OK | |
| 146 | pooled misgrouped 0.022% / 0.030% | data/fig3/fig3c_quality.csv | 2,210 / 2,983 of 10,060,322 = 0.0220% / 0.0297% | OK | |
| 148 | 14 times at 2x5 | out/fig3_runtime_clean_b3_j17.json A2_C5 ratio | 14.02 | OK vs J17; **placed PDF has 16.8 (T1)** | Problem 1 |
| 148 | exhaustive 4.0 ms, greedy 0.28 ms | same | 3.952 / 0.2819 ms | OK vs J17; placed: 3.999 / 0.238 | Problem 1 |
| 148 | greedy 0.70 ms at 4x6 | out/fig3_runtime_clean_b3_j17_a4c6.json | 0.7033 | OK vs J17; placed: 0.6533 | Problem 1 |
| 148 | 4x6 exceeds 10^6 cap, not run | headtohead_b3 caps / A4_C6 status intractable | 1.9e8 > 1e6, 0 frames | OK | |
| 148 | lower bound uses the fastest per-hypothesis rate | panels/fig3_06_head_to_head.py rate_lo = min(rates) | 83.9 µs (2x6) | OK | see Problem 4 for the bar |
| 148 | 1 s of 30 fps video > 5 h | data/fig3c csv 4x6 exhaustive_lo_s | 668.0 s x 30 = 5.57 h (placed T1: 5.65 h) | OK | |
| 150 | 48.7M of 50.4M camera frames | sweep deposit total_camera_frames / _full_session | 48,693,535 / 50,423,670 | OK | |
| 150 | exhaustive 4.2 /100k, IDF1 0.847 | data/fig3/fig3d_frame_matched_rules.csv | 4.185; 0.8469 (mean) | OK | session mean (Problem 6) |
| 150 | r=0: 17.1 /100k, IDF1 0.748 | data/fig3/fig3g_sweep_framematched.csv | 17.08; 0.7478 | OK | |
| 150 | from r=0.02 better on both measures | same | r=0.01: 3.66 sw but IDF1 0.824 < 0.847; r=0.02: 1.88, 0.860; better at every higher r | OK | |
| 150 | r=6: 0.27 /100k, IDF1 0.969, 16x fewer | same | 0.267, 0.9693; 4.185/0.267 = 15.7 | OK | |
| 150 | r 4 to 16 give the same result | same | r=4, 6, 8, 12, 16 all 130 sw / 0.96930 | OK | r=24 differs in IDF1 (0.976) |
| 150 | sweep r 0 to 24, 56 MD sessions | same, 20 rows, n_sessions 56 | 20 values 0-24 | OK | |
| cap E | both medians < 0.01% | quality_b3 per_session | greedy 0.0023%, exh 0.0030% | OK | |
| cap E | outliers up to 4.1% exh, 3.1% LUC3D not drawn | same; fig3_13_quality.py showfliers=False, ylim 0-0.8 | 4.08% / 3.07% | OK | |
| cap E/F | all 2-animal eligible frames, 2,000/session at 3, 1,000 at 4 | headtohead_b3 caps.clean_frames_per_session; frames_computed | 8,000 = 4x2,000; 3,000 = 3x1,000 | OK | |
| cap F / 285 | timing frames 1,000/session (2 animals), 100 (3, 4) | runtime_clean_b3_j17 `k` | {1000,1000,100,100}; a4c6 100 | OK | |
| cap B | dotted line at 10^6 | fig3b png | drawn | OK | |
| cap box plots | median, IQR, whiskers 1.5 IQR | fig3_13_quality.py boxplot defaults | whis default 1.5 | OK | |
| cap | tail in tracking MD, out on SLAP; out of GT matching | sweep deposit tail_in_tracking true; greedy.json excludeTail True (SLAP); quality caveats | consistent | OK | see Problem 5 |
| cap / 285 | three rounds, median round | J17 log "3 round(s)" | 3 | OK | |
| 285 | 3- and 4-animal configs 0.87 and 1.5 s/frame | J17 timing exhaustive | 0.873 / 1.535 s (enumeration run 0.885 / 1.543) | OK / ROUNDING | Problem 7 |
| 285 | 2-animal 4.0 to 5.4 ms | J17 | 3.952-5.369 ms (enumeration run 3.89-5.41) | OK / ROUNDING | Problem 7 |
| 285 | load median 6 on 64 cores | j17 sitting median_1min_load, cores | 6.28, 64 | OK | a4c6 note median 5.4 |
| 285 | processor time checked every 5 s | J17_watch.jsonl (5 s cadence) | yes | OK | but sitting.valid=false (Problem 3) |
| 285 | 4x6 greedy on 100 eligible frames/session | J17_a4c6.log | 3 sessions x 100 | OK | |
| 285 | Node.js 26, LUC3D v1.0.5 (2dc001fe) | j17 deposits lucid_commit; sweep node v26.10.0 | 2dc001fe | OK | provenance_rederive_b3.json: 196/196 greedy cells identical |
| 285 | startup roughly doubles cost on 100-frame runs | none | - | UNVERIFIABLE | Problem 9 |
| 287 | IOU 0.5 GT matching, tail excluded | quality_b3 caveats | IoU 0.5 | OK | |
| 275-281 | defaults w2D=1, w3D=6, d2D=10, d3D=25 mm, λ=0.1, N=20 | lucid-main-md56 @2dc001fe ui/settings.js ACTION defaults | 1, 6, 10, 25, 0.1, 20 | OK | |
| 275 | app default node weight 1 | pose/cross-view-tracker.js _nodeWeight | null -> 1 | OK | |
| 277-281 | 2D / 3D term formulas | cross-view-tracker.js _adjacency2d / _adjacency3d | match | OK | |
| 289 | twenty r values, w2D fixed at 1 | sweep deposit grid_corr3d 20, grid_corr2d 1 | yes | OK | |
| 292 | subset IDF1 0.92 / 0.96 / 0.97 / 0.97 | out/fig2_cams_identity_b3.json per_run within_idf1 (mean per subset, then over subsets) | 0.922 / 0.960 / 0.973 / 0.968 | OK | |
| 292 | switches 166-254 / 96-316 / 92-132 / full 144 | same, within_switches summed | k2 166, 234, 254; k3 96, 136, 316; k4 92, 114, 132; k5 144 | OK | |
| 292 | full run reproduces main result exactly | fig2_cams_identity_b3 gate | passed, max_abs_diff 0.0 vs fig8_methods_50_b3 | OK | |
| 204 | within-view IDF1 0.92 (2 cams) to 0.97 (4, 5) | same | 0.922 -> 0.973 / 0.968 | OK | |
| 200 | 0.28 to 0.70 ms per frame | J17 greedy, all configs | 0.282-0.703 | OK vs J17; placed PDF 0.238-0.653 | Problem 1 |
| 200 | over an order of magnitude faster | J17 ratios | min 14.0x | OK | |
| 200 | misgroups fewer frames; 3D term needed | quality csv; sweep r=0 | 2,210 < 2,983; r=0 worse than exhaustive | OK | |
| 331 | 42 multi-animal SLAP-2M sessions | 35 + 4 + 3 | 42 | OK | |
| 351 | nine mice (4 M, 5 F), 18 pairings | data/fig5/fig5f_leader_by_session.csv male_id / female_id | 4 male, 5 female IDs (sessions with displays only, 17 named pairs) | OK (partial) | 18th pairing not visible in the display-only CSV; MD56-NUMBER-MAP lists no source |
