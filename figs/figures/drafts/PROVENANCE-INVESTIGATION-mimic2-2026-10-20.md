# Independent provenance investigation, eric-mimic2-0-6, 2026-10-20

**Question.** Does every panel and number the paper attributes to LUC3D come from running LUC3D v1.0.5's JavaScript (`/root/vast/eric/lucid-main-md56`, `2dc001fe`)? And is everything else credited to what really produced it?

**Method.** Four read-only audits ran in parallel, one per figure group plus a code scan and number trace. None of them read the other session's plan (`LUC3D-JS-CONSISTENCY-PLAN-2026-10-20.md`), so they are an independent check of it. I re-checked the load-bearing claims myself. Each finding is marked **[verified]** (I checked it here), **[agent]** (reported with file:line, not re-checked) or **[refuted]** (an audit claim I checked and found wrong).

## Verdict

- **LUC3D tracking: real.** Every tracking number (Fig 3E-H, the camera subsets, Fig 4D, Supp Fig 6 A-F) ran v1.0.5's own `pose/` modules. The one exception is Supp 6G, see S1.
- **LUC3D triangulation: partly real.** 2C solver, 2E top, 2F and 2G are real v1.0.5 JS.
- **Not LUC3D:** Fig 2B's measured point, Fig 2D, the 2C alignment, and Fig 5A. They use a NumPy DLT and OpenCV.
- **Not credited correctly:** several panels show dataset-native 3D, or a build that is not v1.0.5. Their text presents them as LUC3D output, or says nothing about the source.

The other session's plan has the core Fig 2 / 5A / 3D items right. Its statement "all of Supp Fig 6 including s-DANNCE is v1.0.5" is **wrong** (S1), and it misses about ten items (section 3).

## 1. The harness: what "LUC3D JS" means here [verified]

| Check | Result |
|---|---|
| Pinned checkout | `lucid-main-md56` HEAD `2dc001fe527c…`, `git status` clean apart from untracked `scripts/bench/node_modules` |
| Tracker driver `fig3-bench/fig3_bench.mjs` | imports `$LUCID_ROOT/pose/pose-data.js` and `tracker.js` and calls `runCrossViewTracker` |
| Loader hook `scripts/bench/hooks.mjs` | stubs only UI modules (settings, app-state, save-load, rendering, info-panel, `pose/initialization`). `pose/` loads unmodified |
| Hook threshold defaults vs app `ui/settings.js` `TRACKING_THRESHOLDS` | all 25 equal. The missing `reprojErrorThreshold` resolves to `undefined`, which behaves like the app's 0 (`triangulation-core.js:1450-1453`) |
| Driver loop vs Track All | Track All runs the same `createTrackerRun` + `stepTrackerFrame` loop. Its post-pass `runIdSwitchChecks` (`autoSwitchCheck`, on by default) only flags switches for the user and never changes identities (`ui/id-switch-modal.js:401-453`). Driver output = Track All output |
| Calibration parser in the drivers | a line-for-line copy of the app's `parseCalibrationTOML` (`import-export/file-io.js:133-204`) feeding the app's `Camera`. Equivalent, but a copy. **Minor**: import the app's, or note it |
| Live fork harness | `fig6-bench/fig6_bench.mjs` hard-codes the scratch repo's `pose/` + `xv_experimental.js`. `fig3_sweep50.py` and `fig3_hh_freshanchor.py` fall back to it when their env var is unset [agent]. No placed deposit used it (`experimental_tracker` null, commit 2dc001fe). **A loaded gun**: make `LUCID_ROOT` mandatory in those scripts |

## 2. Panel-by-panel findings

Class: **A** v1.0.5 JS, **B** LUC3D JS but another build, **C** Python reimplementation, **D** baseline, **E** dataset-native, **F** illustration.

### Fig 1, Fig 2 (fig2c)
| Item | Class | Finding | Fix |
|---|---|---|---|
| 2B measured point (75 -> 32 placements, "cuts placements in half": abstract, Results, Discussion) | **C** | `fig2.json` from `fig2_measure.py:92 triangulate_batch` (NumPy SVD DLT) + `cv2.projectPoints` [agent] | other plan J2 |
| 2D two-view error vs angle (12.6 / 2.7 / 1.2 mm) | **C** | same NumPy DLT. `fig2_solvers_by_views.mjs:1-8` itself warns against measuring this reimplementation [agent] | J2 |
| 2C mm scale (4.74 / 1.21 mm; abstract "1.2 mm") | A solver, **C alignment** | The reference is RANSAC-similarity-aligned to a Python DLT of the same detections, and `mm_per_unit` comes from that fit (`fig2_solvers_export.py:161-166`) [agent]. The k = 5 value is partly an alignment residual | J3 |
| 2E bottom (2.06 -> 1.72 px) | A solver, **driver rule** | Unconditional single-worst-view drop (`fig2_solvers_robust_sessions.mjs:97-112`), not the app's threshold-gated iterative rule that Methods L299 describes (`triangulation-core.js:1450-1497`) [verified for the app rule] | J7 / D2 |
| 2E top, 2F, 2G | A + D | clean. 2G excludes undistortion, which Methods L303 states [verified]. Discussion L198 "32 times" has no caveat (about 10x including undistortion) [agent] | add the caveat at L198 or cite L303 |
| 2A tiles, 1A tracking tiles + "21 names -> 3 identities", 1C pose | **B** | Captured from the eric/figs working tree, Aug 25-26, not 2dc001fe (`_drive.mjs:20,36`) [agent]. **Eric D4 (2026-10-20): keep.** Then 1A's quantitative claim (21 / 3 / 1 duplicate) is from a pre-release tracker. Either re-check it on v1.0.5 or make the caption say "an earlier build" | Eric |
| 1D arenas, 1C arena box | E/F (+ C geometry) | Dataset 3D, aligned by NumPy `triangulate_batch` (`fig1_bmimica_scene.py:113,272`). Caption says "tracked 3D poses" [agent] | caption: "the dataset's proofread 3D" |
| Fig 1 letters | — | `assemble.py:253-257` (a = arenas … e = tool table) disagrees with the caption (A = association … D). The placed `figs/fig1.pdf` is not in the repo [agent] | already in the other handoff |
| Abstract "16,030 fps", "14,694 fps" | hand | Eric's in-app measurements in Chrome on his 16 GB Apple M1 MacBook Pro. No deposit. Cannot be derived from the 2G bench (0.95 µs/keypoint) | provenance sentence (mimicc handoff) |
| Datasheet (tex L491) | E | `figures/drafts/figs/datasheet_combined.pdf` is the **Aug 18** copy. It says Mouse-Dyad sex "Male", proofreaders "?", which contradicts the tex. A newer Oct 1 copy is in `figures/datasheets/` [agent] | **NEW**: replace with the Oct 1 PDF |
| Fig 9 Panopticon | not LUC3D | no generator or deposit in the repo [agent] | **NEW**: add the generator, or note it |

### Fig 3 (fig3c)
| Item | Class | Finding | Fix |
|---|---|---|---|
| 3E-H greedy | A | v1.0.5, `lucid_commit` 2dc001fe in the variant deposits [agent]. Cache re-derivation: see section 4 | — |
| 3F timing | A/D | clean sitting, identical frames [verified, earlier today]. Greedy includes per-process JIT warm-up (up to about 2x at 100-frame cells) — stated in Methods. Not stated: the drivers run headless in Node v26, not in the browser | **NEW**: add "headless Node v26" to Methods |
| 3G/H exhaustive reference (4.2 /100k, IDF1 0.847, L150) | D | `fig3_exhaustive.mjs:19-23,333-358` adds **Hungarian 3D-centroid identity threading** across frames. Maree 2024 has none, and Methods L285 describes only per-frame lowest-error selection [agent] | **NEW**: describe the threading in Methods L285 |
| L289 "twelve values of r" | — | the deposit grid has 20 values [agent; consistent with `data/fig3c/fig3g_sweep_framematched.csv`, 20 rows, verified] | in this host's handoff |
| 3C hypotheses render | E/F | dataset proofread 3D [agent] | caption could say so |
| 3D identity switch | **C**/F | NumPy DLT + Python matcher + staged swap (`hardfight_common.py:155-241`). **Eric D3 (2026-10-20): keep as is.** The caption and Methods L354 ("built by a script from the data") must not imply LUC3D produced it | caption: "illustration, 3D reconstructed offline" |
| Stale self-descriptions | — | sweep50 caveats still name `fig6_bench`/`xv_experimental`. Several placed deposits lack `lucid_commit` (`fig3_quality_b3`, `fig3_headtohead_b3`, `fig3_exhaustive_bmimica_b3`, `fig3_frame_matched_bmimica_b3`, `fig2_cams_identity_b3`) [agent; commit fields verified absent] | J12, section 4 |

### Fig 4, Fig 5, calibration, videos
| Item | Class | Finding | Fix |
|---|---|---|---|
| 4D IDF1 by difficulty | A | v1.0.5. The deposit has no commit field and still says `"status": "EXPLORATORY -- not part of the manuscript."` [agent] | **NEW**: stamp it, drop the label |
| 4A cages | E/F | The poses are the dataset's own Anipose 3D, and the caption says "tracked". **The green enrichment objects are synthetic placements** (`enrichment_scene.py:16-19`), not disclosed in the caption [agent] | **NEW**: caption |
| 4B/C | E | not LUC3D, fine. The matching drops matches over **60 px** (`fig4_detections.py:86`), which counts them as unlabeled. Undisclosed in Methods L309 [agent] | **NEW**: one Methods clause |
| 4C triage fields | C, not placed | NumPy DLT + OpenCV. No panel or tex reads them | **done here (J9)**, section 5 |
| 5A projections | **C** (3D E) | NumPy DLT + RANSAC-Procrustes + `cv2.projectPoints` (`fig5_views.py:114-127,190`) [agent] | J4 (Eric: must use LUC3D JS) |
| 5B-G statistics | E | Dataset-native `points3d_translated_rotated_metric.h5` (2025-10-21). Eric: fine, since the paper presents the dataset. **But the heading L173 "LUC3D reveals a geometric social motif" and Discussion L196 attribute it to LUC3D**, and the tex never says which tool made this 3D [agent; heading verified] | **NEW**: retitle ("3D pose reveals…"), and state the 3D's origin |
| 5G | E | the placed fig5.pdf predates the per-direction fix (`figures/fig5f5fix`) [agent] | **NEW**: check which version ships, recheck the G numbers |
| Calibration figure (tex `fig8.pdf`) | D | numbers match `out/fig7_calibration.json`, but the generator reads a **deleted** `/tmp/claude-0/…/calibrat3/…/bench`, and no calibrat3 commit is recorded. **Not reproducible** [agent] | **NEW**: vendor the bench + npz, record the commit |
| tex `fig7.png` GUI screenshot | ? | no provenance, no version [agent] | **NEW** |
| Supp Video 3 | F | the on-screen "objects illustrative" caveat was removed in v3. The synthetic objects are undisclosed [agent] | **NEW**: legend |
| Supp Video 4 | B | tex L390 says 8 min 47 s. The shipped `supp_video4_walkthrough.mp4` is 6:28 by the agent's count (no ffprobe here, so not re-verified). Recorded on the live site, not 2dc001fe [agent] | **NEW** |

### Supplementary Fig 6 (fig6c)
| Item | Class | Finding | Fix |
|---|---|---|---|
| 6A-F | A/D | v1.0.5 [agent]. 6A ByteTrack win counts in `fig7_variant_best_c6b3.json` were computed before the no-dedupe rebuild; I recomputed them on no-dedupe: identical (45/56 within, 56/56 cross vs SLEAP; 51/56, 56/56 vs ByteTrack) [verified] | — |
| **S1. 6G s-DANNCE** | **B** | **[verified]** `run_C6_build.sh` never set `FIG6_SDANNCE_AGG`, so fig6c g read `fig10-bench/results/agg` (Aug 25), tracked by `fig10_bench.mjs` on `lucid-switch-correct` (c9b2a325, `fig10_bench.mjs:35-38`). The v1.0.5 rerun (`results_v105`, commit-asserted in `run_SDV105.sh:26-31`) gives an **identical placed CSV** and identical session results (35/41 at 1.0, swaps 0.970 / 0.972 / 0.792 / 0.648). But **the wrong-calibration control differs: tex L423 "0.513" is the old checkout. v1.0.5 gives 0.519.** The randomized (0.500) and spliced (0.5) controls are unchanged | **NEW**: rebuild fig6c with `FIG6_SDANNCE_AGG=figs/fig10-bench/results_v105/agg`; L423 0.513 -> 0.519 (mimicc owns the line) |
| 6E anchor diagram | F on E | Python constant-velocity "prediction" drawn on dataset 3D (`chen_fig_prep.py:30-34`) [agent] | caption: schematic on proofread 3D |

## 3. Against the other session's plan

- **Agree:** J2 (2B/2D), J3 (2C alignment), J4 (5A), J5 (3D, now decided "keep"), J7 (2E drop rule), J8 (captures, decided "keep"), J9, J11, J12, J13, the "twelve values" item and the Fig 1 letters.
- **Wrong in the plan:** "All of Supp Fig 6 (… G s-DANNCE)" is v1.0.5. Placed 6G is from c9b2a325, and tex L423 carries its control value (S1).
- **Missing from the plan:**
  - S1 rebuild + L423
  - exhaustive threading in Methods
  - 4A synthetic objects
  - Fig 5 heading and Discussion attribution
  - 5G per-direction version
  - calibration figure not reproducible
  - tex Fig 7 screenshot provenance
  - Supp Video 3 caveat and Video 4 length/build
  - stale datasheet
  - 4B 60 px gate
  - 4D EXPLORATORY label
  - "headless Node v26" in Methods
  - the Discussion's 32x caveat
  - the fork harness fallback
  - Fig 9 generator
- **D3/D4 consequences the plan should record:** Fig 3D and the Fig 1 / 2A captures stay, so their captions must not say or imply v1.0.5 output.

## 4. Refuted or corrected audit claims

- **[refuted]** "aniposelib 0.7.2 in Methods vs 0.8.0 in the Fig 8 caption is a mismatch". The tex uses 0.7.2 for triangulation and 0.8.0 for calibration, consistently (L236, L301, L433, L473).
- **[refuted]** "Tail left out for SLAP-2M overstates it, because target creation ignores node weights". The 10-19 check (`out/tailnan_check_arms_v105.json`) found output identical with the tail set to NaN on 74/74 sessions and every head-to-head subset, so the tail has no effect.
- **[corrected]** The 32x "with no caveat" is true only of Discussion L198. Methods L303 states the exclusion and both undistortion times.
- **[my earlier error]** I said Fig 3E looked like bars. It is a box plot whose median and lower quartile sit near zero (Eric's D5).

## 5. Fixes made on this host so far (all logged in the JS plan)

- **J11** `fig7_variant_best_c6b3.json`: metadata only. Removed `luc3d_is_experimental`; added `lucid_root` / `lucid_commit` / `driver` / `luc3d_source` from `fig8_methods_50_b3.json` and a `legacy_blocks_note`. Every data block asserted unchanged; backup in `out/md56_logs/x6_backup_2026-10-20/`. The generator `fig6_variant_best_rebuild.py` now writes the same fields and refuses an experimental source.
- **J9** `fig4_detections.py`: the NumPy/OpenCV triage section is now opt-in (`FIG4_PY_TRIAGE=1`) and labelled as not LUC3D. The default path no longer imports `fig2_measure`. The deposit is not regenerated; the plotted part A code is unchanged.
- **J12** `figs/provenance_rederive.py` (new): reruns every cached Fig 3 greedy run at a clean 2dc001fe with the cache's own params and compares the tracker output digest. Result: see the plan log.


## 7. Timing: is it real LUC3D, and was the machine quiet? (Eric, 2026-10-20)

| Sitting | Real v1.0.5? | Nothing else of ours running? | Verdict |
|---|---|---|---|
| Fig 3F T1, 2026-10-19 (294 calls) | **[verified by output]** For each of the 5 configurations, one timed call was rerun on the identical frame list at the pinned checkout. All 5 give identical tracker output (digest of identities + frames). The script also asserts 2dc001fe | per-call gate on our bench markers passed for every call; load median 13.1 (outside container) | clean |
| Fig 3F 4x6 greedy, 2026-10-20 03:22-03:25 | same check, identical | gate passed; load ~11; finished before any audit agent was launched (~04:00) | clean |
| Fig 2G T2, 2026-10-19 18:09-18:57 | `pose_dir` = md56, and the md56 checkout's reflog has one entry (clone at 2dc001fe, 10-14), so it ran v1.0.5 | `run_T2.sh` had **no process gate and no commit assert**. Its load log (576 samples, median 12.5, max 23.6) matches the outside baseline, and SFMB3 ran on the other host | very likely clean, but not provable by gate. Any rerun must use a gated script (J13) |
| Abstract 16,030 / 14,694 fps | Eric's in-app hand measurements, Chrome on an Apple M1 MacBook Pro | n/a | HAND; needs the provenance sentence |

**Weak spot found and fixed.** The timing gate only matched our own bench script names. The audit agents' `ugrep` searches (several cores for 15+ min) would not have tripped it. They ran only after every timing sitting had finished, so no number is affected. `fig3f_timing_clean.py` now also measures the CPU used by every other process in the container (`other_cores`, default limit 1 core, `T_MAX_OTHER_CORES`). It refuses to start or continue above that limit and records the value with every call. Right now it reads 14.8 cores (the J12 re-derivation), so it would refuse, as it should. Leftover agent `ugrep` processes were killed.

**Tex timing fixes (Fig 3 lane):** L200 "0.13 to 0.24 ms" (stale, from the unplaced pre-clean deposit) -> "0.24 to 0.65 ms". L285 "13 of its 64 cores" was a load average, now worded as one and says no other process of ours ran.

## 8. Additions from the code scan and number trace (agent 4)

- **L271 "agree within 0.13%"**: compares Python every frame (1.2074) against JS every 15th frame (1.2090). Mixes implementation with stride, no deposit. J6.
- **L303** "0.42 µs" under the stated best-round rule is 0.41 (0.4149). Minor, mimicc.
- **Fork defaults (loaded guns):** `fig4_slap2m.py:103`, `fig6_methods.py:75`, `fig6_slap2m_fair.py:69,109` default to `fig6-bench/fig6_bench.mjs` (old `pose/` + `xv_experimental.js`). `fig10_bench.mjs:35` defaults to `lucid-switch-correct`. The fork matches v1.0.5 on only 36 of 74 sessions. Placed deposits are right only because run scripts overrode the defaults (`run_M.sh` for Fig 4D). Make the v1.0.5 root mandatory everywhere.
- **Unsourced or hand-typed numbers:** SLAP-2M dataset totals typed from a PNG (`dataset_sheets.py:92-107`); L433/449/453/473 calibration extras; L441 model error 3.0/12.1 and 1.6/4.8 px; all Panopticon numbers (L457-459); Fig 5 pair-level and animal-level P values (printed by scripts, not deposited).
- **L103/L241 "100.8 million 2D poses"** are reprojections of the 3D, not proofread 2D. The wording should say so.
- **L150** does not mention that r = 0.5-2 score slightly better than the default (0.226 / 0.977 vs 0.267 / 0.969). It says "every ratio from 4 to 16 gives the same result", which is true, but a reviewer will see the curve.

## 6. Still open (owner per the JS plan)

1. mimicc: J2, J3, J4, J6, J7, J10, J13-J15, S1 rebuild, and the tex items in section 3.
2. mimic2: finish J9 (equivalence check), J12 (stamps after the re-derivation), the Fig 3 text items (twelve -> 20 values, exhaustive threading, headless Node v26), and the Fig 3D caption under D3.
3. Eric: Fig 5 heading wording; whether the 1A "21 -> 3" claim stays given D4; Supp Video 4 version; the calibration bench recovery.
