# Mouse-Dyad-10M 50 → 56 sessions: old vs new numbers (2026-10-14)

**What was compared.** Every row of `MD56-NUMBER-MAP.md`, with its recipe applied once to the base deposit `figs/out/<stem>.json` (the tail-free bvis5nt run; this reproduces the map's "value now" column in every case) and once to `figs/out/<stem>_md56.json`. The md56 deposits are 56 sessions, pinned to origin/main 2dc001fe (`poseDir` = `/root/vast/eric/lucid-main-md56/pose`), Node v26.10.0. Where no md56 deposit exists (fig2.json, dataset_sheets.json) the base file already covers 56 sessions and the value is unchanged by design. P values are `scipy.stats.wilcoxon(d)` on all raw per-session differences (two-sided, default `zero_method`, `liezl_env`), NOT `fig6_report50.py`. Win counts use strict signs. All values were read with python3 from the files. No value was copied from the map.

**Δ column.** Relative % = (new − old)/old. "count" for integers. **FLAG:** BIG = a non-timing value moved > 5%, or a claim, winner, ordering or P threshold flips, or a rounded value changes its leading digit. TIMING = every timing or speed number. ROUND = only the last quoted digit changes.

**Fig 2G timing rows** were filled from `fig2g_retime_all_md56.json` only after `md56_logs/run_Q2b.out` showed "Q2b DONE" (the first md56 retime ran on a loaded machine and was replaced). See §5.

---

## 1. Figure 2 and triangulation

| L | quoted snippet | old | new | Δ | suggested new tex wording | FLAG |
|---|---|---|---|---|---|---|
| 103 | "a median of 1.2~mm" (2C, 5 cams) | 1.1945 | 1.2090 | +1.2% | "1.2~mm" (unchanged) | |
| 103 | "800 to 4,494 frames per second" | 800.0 / 4,494.2 | 1,150.2 / 33,210 (§5) | +44% / +639% | "1,150 to 33,200 frames per second" | TIMING |
| 126 | "from 75 per animal to 32" | 75 / 32.45 | 75 / 32.45 (fig2.json, already 56; `data/fig2b/fig2b_placements_vs_rig.csv` is byte-identical to `data/fig2/`) | 0 | unchanged | |
| 126 | "2.3x reduction" | 2.311 | 2.311 | 0 | unchanged | |
| 126 | "48 placements per animal, 36\% fewer" | 47.69; 36.4% | 47.69; 36.4% | 0 | unchanged | |
| 126, 135 | "10 pixels" / "$\sim$5 pixels" | 10 / 5 (setting) | 10 / 5 | 0 | unchanged | |
| 128 | "two views is a median 4.74~mm" | 4.7382 | 4.7372 | −0.02% | "4.74~mm" (unchanged) | |
| 128 | "five-view solve is 1.19~mm" | 1.1945 | 1.2090 | +1.2% | "1.21~mm" | |
| 130 | "13 degrees gives 12.6~mm" | 13.46° / 12.60 | 13.46° / 12.60 (fig2.json; fig2d CSV byte-identical) | 0 | unchanged | |
| 130 | "widest at 31 degrees gives 2.7~mm" | 31.49° / 2.676 | 31.49° / 2.676 | 0 | unchanged | |
| 130 | "floor when all five views contribute is 1.2 mm" (2D) | 1.2074 | 1.2074 (fig2.json, 56 sessions, every frame) | 0 | unchanged | |
| 130 | "4.32 pixels … to 3.34 pixels with four" | 4.3189 / 3.3355 | 4.2692 / 3.2976 | −1.2% / −1.1% | "4.27 pixels … to 3.30 pixels with four" | |
| 135 | "band of $\pm$25\%" | 0.25 (setting) | 0.25 | 0 | unchanged | |
| 135 | "lowest error in all 50 sessions" (refined < min(DLT, Anipose linear, Anipose optim no-smooth), reproj_p50) | 50/50 | 56/56 (fig4_md56 + fig4_anipose_md56; same count from `data/fig2b/fig2f_per_session.csv`) | count | "lowest error in all 56 sessions" | |
| 135 | "same 200,000 keypoints (345,000 for the Anipose optimizing solver" | 200000 / 345000 | 200000 / 345000 | 0 | unchanged | TIMING |
| 135 | "B and D on all sessions and C and E to G on a subset" | fig2 56 / fig4* 50 | fig2 56 / fig4_md56, fig4_by_views_md56, fig4_anipose_md56, fig4_robust_sessions_md56 all 56 | count | delete "on a subset"; "B to G on all 56 sessions" | |
| 142 | "ranges from 2.15 to 2.35~pixels" | refined 2.1521, Anipose optim 2.2560, Anipose 2.2646, DLT 2.3482 | refined 2.1461, Anipose optim 2.2470, Anipose 2.2564, DLT 2.3401 (ordering unchanged) | −0.3% / −0.3% | "from 2.15 to 2.34~pixels" | ROUND |
| 142, 198 | "3.8 … times faster" (linear) | 3.7736 | 28.449 (§5) | +654% | "28 times faster" | TIMING |
| 142 | "3.3 times faster" (refined) | 3.3437 | 6.094 (`_default` 6.018) (§5) | +82% | "6.1 times faster" | TIMING |
| 142, 198 | "7.4~$\mu$s per keypoint" | 7.417 | 1.004 (§5) | −86% | "1.0~$\mu$s per keypoint" | TIMING |
| 269 | "every 15th frame across the same 50 sessions" | stride 15 / 50 sessions / 17,013,412 keypoints | stride 15 / 56 sessions / 19,079,133 keypoints (fig4_md56, fig4_input_md56) | count | "every 15th frame across the same 56 sessions" | |
| 271 | "same 50 sessions and agreed to within 0.13\%" | k=2..5: 0.125, 0.010, 0.015, 0.130% (max 0.13%) | fig2.json medians over all 56 sessions vs fig4_by_views_md56 `err3d_mm_across_sessions[k].dlt.p50`: k2 4.7323 vs 4.7372 (0.105%), k3 2.8896 vs 2.8897 (0.005%), k4 1.9157 vs 1.9175 (0.097%), k5 1.2074 vs 1.2090 (0.132%); max 0.132% | +1.7% (max) | "same 56 sessions and agreed to within 0.13\%" (unchanged number) | |
| 271 | "0.1 s intervals" | 0.1 | 0.1 | 0 | unchanged | |
| 299 | "small but consistent decrease" (worst view dropped) | 50/50 both solvers; DLT mean 2.056 → 1.711 px | 56/56 both solvers; DLT mean 2.063 → 1.717 px (fig4_robust_sessions_md56; same as `data/fig2b/fig2e_worst_camera.csv`) | count | unchanged wording (holds in all 56) | |
| 301 | "aniposelib 0.7.2" | 0.7.2 | 0.7.2 (fig4_anipose_md56 `aniposelib_version`; fig2g_retime_all_md56 `aniposelib`) | 0 | unchanged | |
| 301 | "outlier-rejection mode was 75 times slower" | 75.20 | 77.95 (§5) | +3.7% | "78 times slower" | TIMING |
| 301 | "higher held-out error than its own linear solve in all 50 sessions" | 50/50 | 56/56 | count | "in all 56 sessions" | |
| 303 | "0.44 microseconds … aniposelib and 1.31 for this work" | 0.4358 / 1.3110 | 0.4129 / 1.4588 (§5) | −5.3% / +11.3% | "0.41 microseconds … and 1.46 for this work" | TIMING |
| 303 | "single thread … over five rounds … best round" | rounds 5, numba_threads 1 | rounds 5, numba_threads 1 | 0 | unchanged | TIMING |
| 305 | "median reprojection error 2.40 pixels" | 2.4041 | 2.4077 | +0.15% | "2.41 pixels" | ROUND |
| 305 | "use all 15 nodes, including the tail" | 15 | 15 (fig4_anipose_md56 `per_session_optim[].n_joints` = {15}) | 0 | unchanged | |

## 2. Figure 3 and association

Sources as in the map: Fig 3E exhaustive = `fig3_quality_md56.json` field `exhaustive`; Fig 3E greedy = `fig3_quality__…e508a7ab_md56.json` field `greedy` (verified: `data/fig3b/fig3c_quality.csv` greedy rows equal this file, e.g. 2×5 misgrouped 436, not the base file's 442).

| L | quoted snippet | old | new | Δ | suggested new tex wording | FLAG |
|---|---|---|---|---|---|---|
| 103 | "947 to 2,461 frames per second" (3F LUC3D) | 946.7 (4×6, 1.0563 ms) / 2,461.0 (2×5 MD, 0.4063 ms) | **fig3_runtime_md56 (what the panel reads):** 4,092.8 (4×6, 0.24433 ms) / 7,614.2 (2×6 SLAP, 0.13133 ms). The fastest plotted config is now 2×6 SLAP, not 2×5 MD (2×5 MD = 0.15967 ms = 6,263 fps). **fig3_headtohead_md56 per-session greedy (median):** 2×5 0.10866 ms (9,203 fps), 2×6 0.11338 ms (8,820), 3×5 0.13844 ms (7,223), 4×3 0.15275 ms (6,547); no 4×6 (not run). | +332% / +209% | "4,093 to 7,614 frames per second" (or "about 4,000 to 7,600") | TIMING |
| 103 | "below one per 100,000 camera frames" (r=6) | 0.7752 | 0.7159 | −7.6% | "below one per 100,000" (claim holds) | BIG (value only; claim holds) |
| 103 | "mean cross-view IDF1 of 0.865 on Mouse-Dyad-10M" | 0.86512 | 0.87088 (sweep r=6 = fig8 `sync_stale20_dist25`) | +0.7% | "0.871" | |
| 144 | "32 hypotheses … $\sim$190 million" | arithmetic | arithmetic | 0 | unchanged | |
| 144, 285 | "$\sim$4.7 million of the $\sim$9.7 million" | 4,694,160 / 9,678,503 | 5,215,366 / 10,758,845 (MD part 4,845,675 / 10,084,734) | +11.1% / +11.2% | "$\sim$5.2 million of the $\sim$10.8 million" | BIG (expected corpus growth) |
| 146, 157, 243, 285 | "92 sessions" = "50 … and the 42" | 92 = 50 + 42 | 98 = 56 + 35 + 4 + 3 (`n_sessions` 98 in both headtohead and quality md56) | count | "98 sessions" = "56 … and the 42" | |
| 146, 157, 285, 287 | "$\sim$4.6 million frames" | 4,646,644 (GT-scored 4,646,417) | 5,167,850 (GT-scored 5,167,623) | +11.2% | "$\sim$5.2 million frames" | BIG (expected corpus growth) |
| 146 | "every frame correctly in 63 of 92" (greedy) | 63 (MD 46 + SLAP 17) | 69 (MD 52 + SLAP 17) | count | "in 69 of 98" | |
| 146 | "exhaustive enumeration in 51" | 51 (MD 47 + SLAP 4) | 58 (MD 53 + SLAP 5: A2_C6 3→4, A3_C5 1, A4_C3 0) | count | "in 58" | |
| 146 | "misgrouped 0.023\%" (greedy, pooled) | 0.02251% | 0.02024% | −10.1% | "0.020\%" | BIG |
| 146 | "exhaustive enumeration 0.040\%" | 0.04048% | 0.03878% | −4.2% | "0.039\%" | ROUND |
| 146 | "four animals and three cameras … 0\% … 0.80\%" | 0.0 / 0.80% | 0.0 / 0.80% | 0 | unchanged | |
| 157 | "Both methods have a median of 0\%" | 0 / 0 | 0 / 0 | 0 | unchanged | |
| 157 | "up to 5.2\% … and 3.1\%" (exhaustive / greedy max) | 5.218 / 3.072 (both A2_C6 SLAP) | 4.085 / 3.072 (both A2_C6 SLAP; MD maxima unchanged at 0.565 / 0.588) | −21.7% / 0 | "up to 4.1\% … and 3.1\%" | BIG |
| 157, 285 | "2,000 per session … 1,000" | 2000 / 1000 | 2000 / 1000 | 0 | unchanged | |
| 148 | "16 times at two animals in five cameras" | 15.95 (6.482 ms / 0.4063 ms) | **19.51** (3.1155 ms / fig3_runtime_md56 `measured[c5,a2,20250827_141755]` 0.15967 ms). Using the head-to-head deposit's own greedy time (median 0.10866 ms): **28.67** | +22% (runtime) / +80% (hh) | "20 times" (runtime) or "29 times" (same-run) | TIMING |
| 148, 285 | "6.5 ms per frame" / "6.5 to 12~ms" | 6.482 ms (MD) / 12.150 ms (SLAP) | 3.1155 ms (MD; 15,096.5 s / 4,845,675 frames) / 5.4128 ms (SLAP) | −52% / −55% | "3.1 ms per frame" / "3.1 to 5.4~ms" | TIMING |
| 148, 200 | "greedy method 0.4 ms" / "0.4 to 1.1~ms" | 0.406 / 1.056 ms | runtime: 0.160 (2×5) / 0.244 ms (4×6); full plotted range is 0.131 (2×6) to 0.244 ms. hh median: 0.109 (2×5) to 0.153 ms (4×3) | −61% / −77% | "0.16 ms" / "0.13 to 0.24~ms" (or "0.16 to 0.24 ms" if anchored on 2×5 MD as before) | TIMING |
| 148 | "four animals in six cameras … 1.1 ms" | 1.056 ms | 0.244 ms (fig3_runtime_md56 `measured[c6,a4]`). Note 4×5 (0.265 ms, not plotted) is now slower than 4×6. | −77% | "0.24 ms" | TIMING |
| 148 | "more than 12 hours" (4×6 exhaustive lower bound per second of video) | rate_lo 189.8 µs/hyp (A2_C6) → 1,511.6 s/frame → 12.6 h | rate_lo = 84.58 µs/hyp (still A2_C6: 5.4128 ms / 64; A2_C5 = 97.36, A3_C5 = 113.8, A4_C3 = 111.6) → 673.44 s/frame → **5.61 h** (= `data/fig3b/fig3e_head_to_head.csv` `exhaustive_lo_s` 673.44 × 30 / 3600). Upper `exhaustive_hi_s` 21,329 s/frame → 178 h. | −55% | "more than 5 hours" | TIMING, BIG (claim "more than 12 hours" no longer holds) |
| 200 | "over an order of magnitude faster" | 16× – 6,177× | 19.5× (2×5) – 41× (2×6) – 5,028× (3×5) – 8,684× (4×3), runtime-based; ≥ 10 at every config | | holds; if a range is quoted: "20× to 8,700×" | TIMING |
| 285 | "2.1 and 4.3~s per frame" | 2.072 / 4.322 s | 0.885 / 1.543 s | −57% / −64% | "0.88 and 1.5~s per frame" | TIMING |
| 148, 285 | "$10^6$ hypothesis cap" | 1e6 | 1e6 | 0 | unchanged | |
| 150, 289 | "from 0 to 24" / "twelve values of r" | 12 values [0 … 24] | 12 values [0 … 24] | 0 | unchanged | |
| 150, 157, 289 | "50 benchmark … sessions" | 50 | 56 (sweep md56 `len(sessions)` and every `cells[].n_sessions`) | count | "56 benchmark … sessions" | |
| 150 | "91 times per 100,000 … IDF1 of 0.651" (frame-matched exhaustive) | 91.44 / 0.6513 | 89.89 / 0.6572 | −1.7% / +0.9% | "90 times per 100,000 … IDF1 of 0.657" | |
| 150 | "$r = 0$ … 533 switches … 0.618" | 533.28 / 0.6184 | 530.70 / 0.6215 | −0.5% / +0.5% | "531 … 0.622" | |
| 150 | "Every non-zero ratio … does better" | true (worst r=0.25: 3.35 / 0.776) | true (worst r=0.25: 3.36 / 0.783, vs exhaustive 89.89 / 0.657) | | holds | |
| 150 | "$r = 6$, gives 0.78 … 0.865" | 0.7752 / 0.8651 | 0.7159 / 0.8709 | −7.6% / +0.7% | "0.72 … 0.871" | BIG |
| 150 | "ratio to 12 lowers this to 0.70 with almost no change" | 0.6952 / 0.8657 | 0.6445 / 0.8714 (vs 0.8709 at r=6: still almost no change) | −7.3% / +0.7% | "lowers this to 0.64" | BIG |
| 150, 289 | "about 22 million of the 45 million camera frames" | 21,622,345 / 45,021,960 | 24,228,375 / 50,423,670 | +12.1% / +12.0% | "about 24 million of the 50 million camera frames" | BIG (expected corpus growth) |
| 150 | "8.1 times per 100,000 … IDF1 of 0.800" (frame-matched greedy) | 8.075 / 0.7998 (pre-#210 arm) | **1.321 / 0.9280** (`fig3_frame_matched_bmimica_md56.json` `arms.greedy`; = `data/fig3b/fig3d_frame_matched_rules.csv`) | −83.6% / +16.0% | "1.3 times per 100,000 … IDF1 of 0.928" | BIG |
| 150 | "eleven times fewer switches" | 91.442 / 8.075 = 11.32 | 89.895 / 1.3208 = **68.06** | +501% | "68 times fewer switches" | BIG |

## 3. Supplementary Figure 6, camera subsets, eviction

| L | quoted snippet | old | new | Δ | suggested new tex wording | FLAG |
|---|---|---|---|---|---|---|
| 411 | "0.865 within view and 0.865 across" | 0.86499 / 0.86512 | 0.87076 / 0.87088 (`fig7_variant_best_md56` LUC3D; now script-built by `fig6_variant_best_rebuild.py`; equals fig8_md56 `sync_stale20_dist25` exactly) | +0.7% / +0.7% | "0.871 within view and 0.871 across" | |
| 411, 103 | "SLEAP 0.659 to 0.149" | 0.65858 / 0.14851 | 0.66095 / 0.14840 | +0.4% / −0.1% | "SLEAP 0.661 to 0.148" | ROUND (cross) |
| 411 | "ByteTrack 0.754 to 0.177" | 0.75387 / 0.17681 | 0.75530 / 0.17674 | +0.2% / 0 | "ByteTrack 0.755 to 0.177" | ROUND |
| 411 | "about 23\%" | SLEAP 0.2255 / ByteTrack 0.2345 | 0.2245 / 0.2340 (= `data/fig6b/fig6a_within_vs_cross_variant.csv` `ratio`) | −0.4% / −0.2% | "about 23\%" (unchanged; SLEAP is 22.5%) | |
| 407, 485 | "uses the 50 Mouse-Dyad-10M sessions" / "A, 50 …" | 50 | 56 (`arms.*.within.n_sessions`) | count | "uses the 56 Mouse-Dyad-10M sessions" / "A, 56 …" | |
| 204, 293 | "0.68 … 0.86" / "0.68, 0.78, 0.83 and 0.86" | 0.6847, 0.7786, 0.8257, 0.8650 | 0.6847, 0.7823, 0.8282, 0.8708 (mean of `per_run[].within_idf1` per k; 168/168/168/56 runs) | 0 / +0.5% / +0.3% / +0.7% | "0.68 … 0.87" / "0.68, 0.78, 0.83 and 0.87" | ROUND (k=5) |
| 293 | "from 2,259 to 3,385 … to 349 with all five" | 2,259 / 3,385 (third 2,330) / 349 | 2,504 / 3,731 (third 2,610) / 361 | +10.8% / +10.2% / +3.4% | "from 2,504 to 3,731 … to 361 with all five" | BIG (count growth with sessions; ordering of the three pairs unchanged) |
| 293 | "three fixed subsets" | 3/3/3 + k5_full | 3/3/3 + k5_full | 0 | unchanged | |
| 293 | "reproduces the main 50-session result exactly" | passed, max diff 0.0 | `gate.passed` True, `max_abs_diff_idf1` 0.0; k5_full within 0.8707568 = fig8_md56 `sync_stale20_dist25` 0.8707568. (The `gate.reference` string still names `fig8_methods_50.json`, not `_md56`; stale label only.) | 0 | "reproduces the main 56-session result exactly" | |
| 293 | "over the same 50 sessions" | 50 | 56 (`summary.*.n_sessions`) | count | "over the same 56 sessions" | |
| 345 | "$N$ was swept over 1, 10, 20 and 30" | present | present | 0 | unchanged | |
| 345 | "reduced from 50 to 25~mm" | 25 recorded; 50 UNRECORDED | 25 recorded; **50 now recorded** (`shipped.overrides` = `{"thresholds": {"distanceThreshold": 50}}`, `why` = "pre-#210 tracker (distanceThreshold 50, no eviction)") | 0 | unchanged | |
| 347, 415, 485 | "50 benchmark … sessions" / "across the 50 sessions" | 50 | 56 | count | "56" | |
| 485 | "F, … $\sim$45 million camera frames" | 45,021,960 | 50,423,670 | +12.0% | "$\sim$50 million camera frames" | BIG (expected corpus growth) |
| 415 | "fell from 1,917 to 349" | 1,917 / 349 | 2,135 / 361 | +11.4% / +3.4% | "fell from 2,135 to 361" | BIG (shipped count) |
| 415 | "(0.0043\% to 0.0008\% of camera frames)" | 0.004258% / 0.000775% | 0.004234% / 0.000716% | −0.6% / −7.6% | "(0.0042\% to 0.0007\% …)" | BIG (0.0008 → 0.0007, leading digit) |
| 415 | "rose from 0.759 to 0.865" | 0.75889 / 0.86512 | 0.75988 / 0.87088 | +0.1% / +0.7% | "rose from 0.760 to 0.871" | |
| 415 | "median session improved from 0.769 to 0.917" | 0.76907 / 0.91659 | 0.76907 / 0.92056 | 0 / +0.4% | "from 0.769 to 0.921" | |
| 415 | "36 of 50 sessions improving and 10 worsening" | 36 / 10 (4 ties) | 41 / 11 (4 ties), n = 56 (= `vs_shipped` 41/11) | count | "41 of 56 sessions improving and 11 worsening" | |
| 415 | "$P = 8.1 \times 10^{-7}$" | 8.11e-7 | 9.00e-8 | −89% | "$P = 9.0 \times 10^{-8}$" | BIG (exponent change; no 0.05/0.01/0.001 crossing) |
| 415 | "improved by 0.097 … 34 of 50 … $P = 2.4 \times 10^{-5}$" (vs `dist25_corr36`) | 0.0969; 34 (11 worse, 5 ties); 2.37e-5 | 0.1020; 40 (11 worse, 5 ties) of 56; 2.01e-6 | +5.3%; count; −92% | "improved by 0.102 … 40 of 56 … $P = 2.0 \times 10^{-6}$" | BIG (0.097 → 0.102 is > 5%; P exponent change, no threshold crossing) |
| 417 | "1,917 … 625 … 445 … 349 … 391" (shipped, N=1, 10, 20, 30) | 1917, 625, 445, 349, 391 | 2135, 683, 481, 361, 423 | +11.4%, +9.3%, +8.1%, +3.4%, +8.2% | "2,135 … 683 … 481 … 361 … 423" | BIG (counts; ordering unchanged, N=20 still fewest) |
| 417 | "(0.759, 0.845, 0.855, 0.865 and 0.852)" | 0.7589, 0.8453, 0.8545, 0.8651, 0.8523 | 0.7599, 0.8455, 0.8578, 0.8709, 0.8542 | ≤ +0.7% | "(0.760, 0.845, 0.858, 0.871 and 0.854)" | |
| 417 | "(0.769, 0.886, 0.913, 0.917 and 0.905)" | 0.7691, 0.8855, 0.9127, 0.9166, 0.9046 | 0.7691, 0.8855, 0.9139, 0.9206, 0.8991 | 0, 0, +0.1%, +0.4%, −0.6% | "(0.769, 0.886, 0.914, 0.921 and 0.899)" | |
| 417 | "$P = 0.27$, 0.86 and 0.20" (N=20 vs N=1, 10, 30) | 0.2675, 0.8575, 0.2014 | 0.1522, 0.4209, **0.0527** | −43%, −51%, −74% | "$P = 0.15$, 0.42 and 0.053" | BIG (N=30 P is now 0.053, just above 0.05; still n.s. but borderline) |
| 417 | "349 versus 445 … 0.865 versus 0.855 and 0.917 versus 0.913" | as above | 361 vs 481; 0.871 vs 0.858; 0.921 vs 0.914 | | "361 versus 481 … 0.871 versus 0.858 and 0.921 versus 0.914" | |

## 4. Session, frame and dataset counts (MD)

| L | quoted snippet | old | new | Δ | suggested new tex wording | FLAG |
|---|---|---|---|---|---|---|
| 103, 113 | "56 sessions … 50.4 million video frames, 20.2 million 3D poses … 100.8 million 2D poses" | dataset_sheets.json: 56; 50,423,670; 20,169,468; 100,847,340 | unchanged (no md56 deposit; the md56 sweep/fig8 `total_camera_frames` = 50,423,670 agrees) | 0 | unchanged | |
| 196 | "66 million video frames" | 66.0 | 66.0 | 0 | unchanged | |
| 241 | "$\sim$10 million synchronized frames per view, $\sim$20 million 3D instances and $\sim$100 million 2D" | 10,084,734 / 20.17 M / 100.8 M | unchanged (headtohead_md56 A2_C5 `frames_considered` = 10,084,734 agrees) | 0 | unchanged | |
| 241 | "use the 50 sessions … six sessions recorded on 8 September 2025 were added afterwards …" | fig2 56 vs others 50 | every md56 deposit used here has 56 MD sessions (fig4*, fig3*, fig7*, fig8, fig2_cams_identity) | count | delete the paragraph | BIG (claim no longer true) |
| 241 | "female starts 80.0\% … in the 50 sessions leads in all 32 …" | fig5 (out of scope) | NOT RECOMPUTED: no fig5 md56 deposit exists in `figs/out` | | delete with the paragraph, or re-derive on 56 | |
| 241 | "Figures 2B to G, 3E to H, 5, and Supp 6A and F, were measured on this corpus" | ambiguous | true for 2B–G, 3E–H, Supp 6A/F (all 56) | | keep | |
| 243, 146, 157, 285 | "42 multi-animal sessions" (SLAP) | 42 | 42 (35 + 4 + 3) | 0 | unchanged | |
| 144, 285 / 150, 289, 485 | ~9.7 M, ~4.7 M, ~4.6 M / ~45 M, ~22 M | as quoted | ~10.8 M, ~5.2 M, ~5.2 M / ~50 M, ~24 M (see §2, §3) | +11–12% | as in §2/§3 | BIG (expected) |

## 5. Timing (Fig 2G retime) and versions

### Fig 2G retime

Read from `fig2g_retime_all_md56.json` as rewritten at 15:19:39 UTC (after "Q2b DONE" at 15:32:28). Recorded: `rounds` 5, `numba_threads` 1, `node` v26.10.0, `opencv` 4.13.0, `aniposelib` 0.7.2, `pose_dir` lucid-main-md56. **Caveat:** `md56_logs/run_Q2b.out` reports a max 1-min load of **39.3** (64 cores) during the sitting and 28.0 when `retime_all` exited, so this was not a quiet machine. Best-of-5 hides most of it, but per-arm run spreads (max/min) were 1.83× for `luc3d_dlt` (1.00–1.84 µs), 1.68× for `luc3d_undistort`, 1.22× for `anipose_optim_nosmooth`, and 1.06–1.13× for the rest. **`data/fig2b/fig2g_time_per_keypoint.csv` is stale:** it still holds the first, loaded retime (DLT 1.1732, refined 26.892, Anipose 29.199, Anipose optim 162.52) and must be rebuilt from this file.

| L | quoted snippet | old | new | Δ | suggested new tex wording | FLAG |
|---|---|---|---|---|---|---|
| 103 | "800 to 4,494 frames per second" (fps = 1e6 / (µs × 30)) | refined 41.666 µs → 800.0; DLT 7.417 µs → 4,494.2 | refined 28.982 µs → **1,150.2**; DLT 1.0037 µs → **33,210** | +44% / +639% | "1,150 to 33,200 frames per second" (or "about 1,100 to 33,000") | TIMING |
| 135 | "same 200,000 keypoints (345,000 for the Anipose optimizing solver" | 200000 / 345000 | 200000 / 345000 (`n_linear`, `n_optim`) | 0 | unchanged | TIMING |
| 142, 198 | "3.8 … times faster" (linear) | 3.7736 (27.988 / 7.417) | **28.449** (Anipose linear 28.555 / DLT 1.0037) | +654% | "28 times faster" | TIMING |
| 142 | "3.3 times faster" (refined vs Anipose optim, no smoothing) | 3.3437 (139.318 / 41.666); `_default` 3.330 | **6.094** (176.615 / 28.982); `_default` 6.018 (174.424 / 28.982) | +82% | "6.1 times faster" | TIMING |
| 142, 198 | "7.4~$\mu$s per keypoint" (LUC3D DLT) | 7.417 | **1.004** | −86% | "1.0~$\mu$s per keypoint" | TIMING |
| 301 | "outlier-rejection mode was 75 times slower" (`ransac_over_linear`) | 75.20 (2,104.8 / 27.99) | **77.95** (2,225.8 / 28.555) | +3.7% | "78 times slower" | TIMING |
| 303 | "0.44 microseconds … aniposelib and 1.31 for this work" (undistortion) | 0.4358 / 1.3110 (ratio 3.01) | **0.4129 / 1.4588** (ratio 3.53; aniposelib still faster) | −5.3% / +11.3% | "0.41 microseconds … aniposelib and 1.46 for this work" | TIMING |
| 303 | "single thread … over five rounds … best round" | rounds 5, numba_threads 1 | rounds 5, numba_threads 1; best = min(`runs_us_per_keypoint.X`) verified for every arm | 0 | unchanged | TIMING |

Other timing deposit, not quoted in the tex: `fig4_anipose_optim_retime_md56.json` (written 15:32:27, `repeats` 3). The older first-pass md56 retime values (DLT 1.173, refined 26.89, speed-ups 24.9× / 6.04×) were superseded and are not used anywhere above.

### Versions

| L | quoted snippet | old | new | suggested new tex wording | FLAG |
|---|---|---|---|---|---|
| 236 | "Node 26" | v26.10.0 (retime), v26.5.0 (fig4_anipose recheck) | v26.10.0 in fig2g_retime_all_md56 `node` and fig4_anipose_md56 `timing.luc3d_recheck.node`. Other md56 deposits (fig3_*, fig8, fig2_cams_identity, fig4, fig4_by_views) still record no Node version | "Node 26" (unchanged) | |
| 236, 301 | "aniposelib 0.7.2" | 0.7.2 | 0.7.2 | unchanged | |
| 301 | "corrects for lens distortion with OpenCV" (no version) | OpenCV 5.0.0.93 (env, unrecorded) | **4.13.0** recorded in fig4_anipose_md56 `opencv` and fig2g_retime_all_md56 `opencv`; env `anipose072_cv413_env` | add "OpenCV 4.13.0" at L301 (and L236); now consistent with L433 | |
| — | code commit | unrecorded (two trees: lucid-main-timing @1d672c12, lucid-bundle-adj) | still no commit hash in any md56 deposit; all md56 Fig 2 deposits record the single tree `/root/vast/eric/lucid-main-md56/pose` (fig4, fig4_by_views, fig4_anipose recheck, fig2g retime) | state "2dc001fe" from the run log, not the deposit | |
| 267, 337 | "sleap-nn 0.3.0" (MD) | unrecorded | "sleap-nn 0.3.0" now appears in fig7_fair_baselines_md56 / fig7_variant_best_md56 text fields (not a structured version field) | unchanged | |
| 339 | ByteTrack (no version) | supervision 0.30.0 (env) | "supervision 0.30.0" appears in fig7_fair_baselines_md56 gate text | consider adding to Methods | |
| — | HH_JOBS for exhaustive timing | 16-way | still 16-wide (`md56_logs/Q3_headtohead.log`: "98 driver jobs, 16-wide"); not recorded in the deposit | describe protocol | TIMING |

---

## 6. Claims that no longer hold or need rewording

### BIG items

1. **L150 frame-matched greedy, 8.1 / 0.800 → 1.32 / 0.928, and "eleven times fewer" → 68 times fewer.** The head-to-head greedy arm is now the post-#210 tracker, so the comparison with exhaustive (89.9 / 0.657) is about six times stronger. The sentence needs new numbers, not just a session count.
2. **L148 "more than 12 hours" → 5.6 hours.** Exhaustive enumeration got 2.1–2.8 times faster on main (A2_C6 is 84.6 µs per hypothesis, down from 189.8). The 4×6 lower bound is now 673 s per frame, so one second of video is ≥ 5.6 h. The bound is still set by the SLAP A2_C6 config. A2_C5 is 97.4 µs per hypothesis, so it would need to drop below 2.71 ms per frame to take over.
3. **L157 exhaustive maximum misgrouping, 5.2% → 4.1%.** The re-run SLAP A2_C6 exhaustive arm changed: perfect sessions went from 3 to 4, the max from 5.218 to 4.085%, and the A3_C5 max from 0.35 to 0.55%. Exhaustive enumeration is deterministic per frame, so the SLAP exhaustive outputs differ between code versions or pools. Worth a one-line check of why before quoting. The greedy max (3.1%) is unchanged.
4. **L146 greedy pooled misgrouping, 0.023% → 0.020%** (−10%). Exhaustive goes to 0.039% (ROUND only). Greedy is still about half the exhaustive rate.
5. **L103/L150 r = 6 switch rate, 0.78 → 0.72 per 100k** (−7.6%). "Below one per 100,000" still holds.
6. **L150 r = 12, 0.70 → 0.64 per 100k** (−7.3%). "Almost no change" in IDF1 still holds (0.8709 → 0.8714).
7. **Corpus-growth counts (+11–12%, all expected):**
   - L144/285 ~4.7 M / ~9.7 M → ~5.2 M / ~10.8 M.
   - L146/157/285/287 ~4.6 M → ~5.2 M.
   - L150/289 ~22 M / 45 M → ~24 M / 50 M.
   - L485 ~45 M → ~50 M.
   - L293 2,259–3,385 → 2,504–3,731 (k5 349 → 361).
   - L415/417 shipped 1,917 → 2,135, plus the other N arms.
   - None of these changes a conclusion.
8. **L415 "0.0008%" → 0.0007%.** The leading digit changes (0.000775 → 0.000716%).
9. **L415 eviction vs best re-tune: 0.097 → 0.102** (+5.3%), and P 2.4e-5 → 2.0e-6. L415 eviction vs shipped: P 8.1e-7 → 9.0e-8. Neither P value crosses 0.05, 0.01 or 0.001. Both are just stronger, but the exponents change in the text.
10. **L417 N=20 vs N=30, P = 0.20 → 0.053.** It is still not significant at 0.05, but it is now borderline. A reader may question "no significant difference between horizons". N=20 is still best on switches (361), IDF1 (0.871) and median (0.921). The ordering of all five arms on each metric is unchanged.
11. **L241 paragraph ("use the 50 sessions … six sessions … were added afterwards").** It is now false. Every Fig 2C/E–G, 3E–H and Supp 6A/F deposit is on 56, so delete it as planned. The fig5 claim inside it ("80.0% … all 32") was NOT recomputed, because there is no fig5 md56 deposit.
12. **Timing (all TIMING rows):**
    - LUC3D DLT is now 1.0 µs per keypoint (was 7.4), after PR #300.
    - The linear speed-up is 28× (was 3.8×). The refined speed-up is 6.1× (was 3.3×).
    - Fig 2G fps is 1,150–33,200 (was 800–4,494).
    - Fig 3F LUC3D is 4,093–7,614 fps (was 947–2,461). The fastest plotted config is now SLAP 2×6, not MD 2×5. Anchored on MD 2×5, it is 6,263 fps.
    - Greedy is 0.16 ms at 2×5 (was 0.4) and 0.24 ms at 4×6 (was 1.1).
    - Exhaustive is 3.1 ms (MD) and 5.4 ms (SLAP), was 6.5 and 12. At A3_C5 / A4_C3 it is 0.88 s / 1.5 s, was 2.1 / 4.3.
    - The speed-up at 2×5 is 19.5×, was 16×.
    - "Over an order of magnitude" still holds at every config (minimum 19.5×).
    - Fig 3F appears on L103, 148, 200 and 285. Fig 2G appears on L103, 142, 198, 301 and 303.

### §6a inconsistency list: resolved or worsened

- **6a.1 (L150 mixes two trackers): mostly RESOLVED.** I checked this against fig8.
  - Base: the head-to-head greedy arm equals fig8 `shipped` exactly (50/50 switch counts, max |ΔIDF1| 0).
  - md56: it matches `sync_stale20_dist25` in 53/56 sessions (switch counts; max |ΔIDF1| 0.081, total 367 vs 361 switches).
  - So 1.32 / 0.928 and the r = 6 numbers (0.72 / 0.871) are now the same tracker, near enough.
  - The deposit's `greedy_arm` / `claim` strings in `fig3_frame_matched_bmimica_md56.json` still say "default thresholds … NOT the fresh-anchor operating point" and "50 BMimica sessions". Those labels are stale.
- **6a.2 (L148 "identical detections", timing protocol): CHANGED, not resolved.**
  - The head-to-head deposit's own greedy time at 2×5 is now a median 0.109 ms. That is *faster* than the fig3_runtime figure of 0.160 ms (ratio 0.68). Before, it was 3.7× *slower*.
  - Exhaustive still ran 16-wide (`Q3_headtohead.log`: "98 driver jobs, 16-wide"). HH_JOBS is still not recorded in the deposit.
  - `panels/fig3_06_head_to_head.py` reads LUC3D from `fig3_runtime.json` `measured`. `data/fig3b/fig3e_head_to_head.csv` `luc3d_s` equals `fig3_runtime_md56.json`, not the head-to-head per-session times.
  - The 16× → 19.5× (runtime) vs 28.7× (same-run greedy) choice should be made explicit.
- **6a.3 ("1.2 mm" double meaning): RESOLVED numerically.** 2C (fig4_by_views_md56, every 15th frame) is 1.2090 and 2D (fig2.json, every frame) is 1.2074. Both use the same 56 sessions now, and they differ by 0.13%. Both round to 1.2. L128 should now say 1.21 (was 1.19).
- **6a.4 (L241 self-contradiction): RESOLVED by deleting the paragraph.** Everything is on 56.
- **6a.5 ("50 sessions" / "a subset" / "92"):** every one becomes 56 / 98, as listed in the tables. No row still needs 50.
- **6a.6 (L150 different denominators): UNCHANGED.** Exhaustive is over 24.2 M clean camera frames and the sweep over 50.4 M. The frame-matched pair (89.9 vs 1.32) is the like-for-like comparison.
- **6a.7 (L204 vs L411 rounding):** 0.8708 rounds to 0.87 (L204) and 0.871 (L411). Keep both in sync.
- **6a.8 (12-hour bound set by SLAP):** still A2_C6. It now gives 5.6 h (see BIG 2).
- **6a.10 (stale `fig2s1_cams_identity.csv`):** not checked against md56. There is no `data/fig2b/fig2s1_cams_identity.csv`. Regenerate it in the md56 build.
- **6a.11 (`fig7_variant_best` hand-built): RESOLVED.**
  - md56 is script-built (`generated_by` = `figs/fig6_variant_best_rebuild.py --tag md56`).
  - LUC3D equals fig8_md56 `sync_stale20_dist25` exactly.
  - Its `SLEAP per-camera` / `ByteTrack` keys now match fig7_fair_baselines_md56 (0.661/0.148, 0.755/0.177).
  - The key is still named `bmimica_50_sessions` while holding 56.
- **6a.12 (`fig6_report50.py`):** not used. All P values above are from scipy on raw differences.
- **6b.4 (OpenCV): RESOLVED.** The Anipose arm records `opencv` 4.13.0 in both fig4_anipose_md56 and fig2g_retime_all_md56. Add "OpenCV 4.13.0" at L301.
- **6b.6 (shipped settings unrecorded): RESOLVED.** fig8_md56 `shipped.overrides` = distanceThreshold 50. Note that `fig3_sweep50_md56.json` still has empty `base_method` / `base_thresholds` for the shipped sweep, but that file is not quoted.
- **6b.1/6b.3 (code version / Node):** improved, not resolved.
  - All Fig 2 md56 deposits point at one tree (`lucid-main-md56/pose`), and the retime and recheck record Node v26.10.0.
  - No md56 deposit records the commit hash 2dc001fe.
  - The fig3/fig8/cams deposits still record no Node version.
- **6b.2 (rounds): RESOLVED.** `rounds` is 5, matching L303.
- **New issue: "quiet machine" for Fig 2G is not supported by the log.** The max load during the Q2b sitting was 39.3 on 64 cores. Best-of-5 is robust here except `luc3d_dlt` (run spread 1.00–1.84 µs). Consider re-running if the 1.0 µs / 28× numbers matter.
- **New issue: stale CSV.** `data/fig2b/fig2g_time_per_keypoint.csv` still carries the superseded first md56 retime. Rebuild it.
- **New issue: unexplained SLAP exhaustive change.** The SLAP exhaustive quality changed between base and md56 (BIG 3). The SLAP sessions were not supposed to change.
- **Caveat on the Fig 3E greedy source.** `fig3_quality_md56.json`'s own `greedy` field is not the fresh file. It gives 62 perfect sessions, and A4_C3 median 1.3% (greedy) vs 0.8% (exhaustive), which would flip L146's "0% vs 0.80%" claim. The panel and CSV correctly use the fresh `e508a7ab` file (69 perfect, A4_C3 median 0%). Do not switch sources.
