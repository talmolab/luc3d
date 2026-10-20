# Consistency plan, 2026-10-19

The working document for making every comparison in the paper use the same data and the same preprocessing. It comes out of the 2026-10-19 three-part audit (Fig 2/7 triangulation and calibration, Mouse-Dyad tracking, SLAP-2M and s-DANNCE tracking). Update the status column and the log at the bottom after every step.

Status values: `todo`, `running`, `done`, `blocked`, `decision` (waiting on Eric).

## The rules

These apply to every comparison: every arm, every panel, every number quoted in the tex.

1. **Mouse-Dyad-10M.** 56 sessions. Body >= 5 pool (`det_h5_bvis5`, the "b3" series). The tail nodes are USED in tracking by every arm.
2. **SLAP-2M.** 74 sessions. Body >= 5 pool (`lite_pools/bvis5`). The tail is NOT used in tracking by any arm.
3. **Scoring is tail-free everywhere** (`SCORE_NOTAIL=1`).
4. **No ByteTrack slot dedupe** (`STITCH_DEDUPE` unset) in any deposit a figure reads.
5. **No other filters.** The pool filter above is the only one. SLEAP is capped at the animal count and ByteTrack is stitched to it, as in the published "fair" setup.
6. **LUC3D v1.0.5** (`2dc001fe`, `LUCID_ROOT=/root/vast/eric/lucid-main-md56`) for every LUC3D number.
7. **Exact data match.** Within a comparison, every arm has the same sessions, frames, cameras and keypoints. Each step below needs a gate that ASSERTS equal per-session counts. "Within 0.1%" or "438 of 19M missing" fails.
8. **Timing.** Nothing else of ours runs during a timing sitting. Both arms use the same frames and the same timer scope, run one process at a time, and are interleaved. Host load is recorded with every measurement.
9. **Triangulation (Fig 2) keeps all 15 nodes.** This is deliberate and stated in Methods. Every arm does the same.

Outside load we cannot control: on 2026-10-19 the host showed load of about 11 (about 11 of 64 cores busy) with nothing of ours running. Those processes are outside this container. Timing therefore interleaves the two arms per session and repeats the measurement in rounds, so any drift lands on both arms equally. The recorded load goes in the deposit.

## Phase T: timing (quiet machine, nothing else of ours running)

| ID | Item | Status |
|---|---|---|
| T1 | Fig 3F clean timing (b3) | [x] done 2026-10-19 22:43 + 4x6 greedy-only sitting 2026-10-20 03:25 (`fig3_runtime_clean_b3_a4c6.json`, 0.653 ms). fig3c F rebuilt from them (`FIG3F_CLEAN=1`) |
| T2 | Fig 2G clean retime (audit item C1) | [x] done 18:57 UTC: `out/fig2g_retime_all_md56T2.json` (run script `md56_logs/run_T2.sh`) |
| T3 | Fig 7H calibration timing rerun (Eric 2026-10-19: "yeah rerun Fig7H") | [x] closed 2026-10-20: Eric chose NOT to rerun. L435 softened to 'with each tool run on its own on a 64-core machine'. 7H stays as published |

### T1. Fig 3F: greedy vs exhaustive on identical frames

The problem: the exhaustive arm was timed with 16 parallel jobs at load 4.7 to 17, and LUC3D was timed as one process at load about 2. Frame sets also differed: exhaustive used the capped clean frames, LUC3D the first 3,000 frames of one session. The tex claims "identical detections", "20x", "3.1 vs 0.16 ms", "0.13-0.24 ms", ">5 hours" and "4,093-7,614 fps".

The fix: a new script `figs/fig3f_timing_clean.py`, under `FIG3_VARIANT=b3`.
- **Cells:** A2_C5_bmimica (56 sessions), A2_C6_slap2m (35), A3_C5_slap2m (4), A4_C3_slap2m (3). A4_C6_slap2m_hard stays analytic. Its per-hypothesis rate is re-measured in the same sitting, because the ">5 hours" claim has only a 12% margin.
- **Frames:** per session, the same K frames for both arms. They are drawn uniformly (fixed seed) from the frames the b3 exhaustive cache already enumerated, so every frame is eligible for exhaustive. K = 1,000 for the A2 cells and K = 100 for A3 and A4, about 20 min of exhaustive time per round. Both drivers take a `--frame-list`. This adds an opt-in `--frame-list` to `fig3_exhaustive.mjs`, which today has none.
- **Tail:** Mouse-Dyad with the tail in both arms (greedy `--no-exclude-tail`, exhaustive without `--exclude-tail`). SLAP-2M tail-free in both. See X2 for the tail-NaN question on the greedy arm.
- **Timer scope:** solve only, in both arms. Exhaustive `enumerationSeconds` (eligibility scan excluded), greedy `runtimeSeconds` (`runCrossViewTracker` only).
- **Execution:** one process at a time. Greedy and exhaustive alternate per session, and the order flips each round. 3 rounds. The rate is the median over rounds of sum(seconds) / sum(frames). Record `/proc/loadavg` before and after every call.
- **Gates:**
  - before starting, `pgrep` finds none of our node or python bench processes;
  - both arms report exactly K frames processed for every session;
  - same cameras for both arms;
  - commit 2dc001fe;
  - the round-to-round spread for each cell is reported.
- **Output:** `figs/out/fig3_runtime_clean_b3.json` and `figs/out/fig3_headtohead_clean_b3.json` (new files, nothing overwritten).

### T2. Fig 2G: time per keypoint

The problem: the figure and the tex use run Q2c, which is invalid: Anipose optim used n = 345,000 keypoints against 200,010 for the others. The live deposit `fig2g_retime_all_md56.json` was overwritten by Q2d, which is contaminated (load 28.5). The RANSAC "75x" is not like-for-like. Run C1 exceeded the load ceiling.

The fix: one clean sitting, with all four solvers plus RANSAC on the same 200,010 pre-undistorted keypoints (`undistort=False`), interleaved over rounds, and load recorded. Write to a new tagged deposit. Do NOT rebuild Fig 2 from the current v105 link before this lands.

### T3. Fig 7H: time to calibrate (Anipose vs calibrat3)

The problem: Anipose ran one process per camera with `opencv_threads` 8/12/3 (about 54-64 threads), against calibrat3's 12 workers. Anipose detected on about 2,600 frames per camera, calibrat3 on 900-1,000. The sittings were separate and unlogged. The tex L435 claim "each tool running alone on an idle 64-core machine" cannot be verified.

The fix: the prepared, never-run scripts in `figs/out/md56_logs/calib_b/` (`run_all_b.sh`), stages `prep` then `sitting` only.
- **`prep`** (about 15 min, untimed but CPU-heavy, so it also waits for a quiet machine): one transcode/copy per recording, sha256 recorded, so both tools read the same files. It asserts OpenCV 4.13.0 on both sides.
- **`sitting`** (about 1.5-2 h at REPS = 3): the same three recordings as the published H (md10 20250514_134355, slap 10072022120554, calib18).
  - Both tools are pinned to the same 16-core cpuset (`taskset`) and each sizes its own parallelism to that budget.
  - Back to back, with the order alternated per repeat.
  - `timed_b.py` samples busy cores inside and outside the cpuset every second.
  - A secondary condition runs calibrat3 on every frame (Anipose's frame budget) once.
- **Quiet gate:** `timed_b.py` waits for whole-machine busy cores below `QUIET_CORES`. The default of 1.5 cannot pass while outside load sits at about 11 cores, so set it just above the measured outside baseline and record that. Every timed run still logs outside-cpuset load, so contamination is measured either way.
- **Output:** only `/root/vast/eric/calib-bench-b/**`. H's numbers then go into a new deposit and a fig7 H panel built from it. Panels A-G stay as published unless decided otherwise.
- Checked 2026-10-19: all source recordings, `aniposelib413_env` (cv2 4.13.0), node26, the Playwright browsers and the calibrat3 repo (ff7a542) are present.

## Phase M: Mouse-Dyad-10M (tail in tracking, b3)

| ID | Item | Status |
|---|---|---|
| M1 | Fig 3 = the b3 series (`figures/fig3c`); retire the tail-free md56 Fig 3 | [x] done 2026-10-20: tex includes figs/fig3c.pdf |
| M2 | Finish the b3 frame-matched G/H sweep (SFMB3 stopped at 100/1,120) | [x] done for G/H (2026-10-19 20:27): fig3c G/H plot the d25-stale20 frame-matched greedy curve only (`panels/fig3_05_sweep.py build_framematched`); the d50-stale0 arm is no longer drawn, so it needs no rescore |
| M3 | Fig 6a / Supp 6A ByteTrack: re-stitch WITHOUT dedupe from `tracks_raw`, rescore under b3 | [x] done in fig6c (2026-10-19 ~21:35, eric-mimicc-0-1): `fig7_fair_baselines_c6b3nd.json` built from the no-dedupe ByteTrack deposit (FAIR_SUFFIX=c6b3nd; SLEAP unchanged); `fig7_fair_baselines_c6b3.json` now links to it (dedupe version kept as `_c6b3_dedupe.json`). fig6c rebuilt (recipe first reproduced byte-identical); only `fig6a_within_vs_cross_variant.csv` changed: ByteTrack B1s within 0.8206 -> 0.8251, cross 0.1888 -> 0.1905. Tex numbers for this arm not yet updated (P1) |
| M4 | Camera-subset numbers (tex L293) from the b3 cams deposit | [x] done 2026-10-20 (eric-mimicc-0-1): L293 replaced with proposed section 2 plus the k = 3 range (96 to 316), checked against `out/fig2_cams_identity_b3.json` (k means 0.922 / 0.960 / 0.973 / 0.968; switches 166-254 / 96-316 / 92-132 / 144; k = 5 = b3 N = 20 exactly) |
| M5 | `panels/fig3_04_quality.py:133` glob: exclude `_c6b3` (and any future tag) so 3E cannot pair a b3 greedy arm with an md56 exhaustive arm | [x] done (2026-10-19: base names only, by the 8-hex config hash; verified it resolves to the base deposit) |
| M6 | Exact-match gate for every Mouse-Dyad comparison: same 56 sessions, same per-session camera-frame counts across LUC3D / SLEAP / ByteTrack / exhaustive | [x] done for LUC3D / SLEAP / ByteTrack (2026-10-19, `figs/m6_frame_gate.py` -> `out/m6_frame_gate_b3.json`): 56 sessions, 280 camera-sessions, each arm's own scorer frame count identical everywhere, 50,423,670 camera-frames in all three. Exhaustive is compared frame-matched (fig3_frame_matched, sweep G/H) |

## Phase S: SLAP-2M (tail-free, bvis5)

| ID | Item | Status |
|---|---|---|
| S1 | Fig 6 b-d / Supp 6B-D: tail-free SLEAP, no dedupe (`fig6_slap2m_fair_sleapnt`) | [x] done in fig6c (2026-10-19); main build still md56 |
| S2 | Fig 6c f stale arms 0/1/10/30: show weight-0 tail == tail-NaN input (`tailnan_check.py`, digest), or rerun with `--tail-nan` | [x] done (2026-10-19 20:52, eric-mimicc-0-1): `tailnan_check_arms.py`, all five SLAP-2M stale arms 74/74 IDENTICAL with --tail-nan -> `out/tailnan_check_arms_v105.json`. No rerun needed |
| S3 | Methods note: without dedupe, ByteTrack IDF1 > 1 in 10 of 444 camera-sessions (max 1.0049). It is a scorer artifact of duplicate identity rows, not better tracking | [x] done (2026-10-19 ~22:05): Methods ByteTrack paragraph (~L339) now ends 'After the merge a frame can hold two rows with the same identity, and these duplicate rows are scored as they are. This raises ByteTrack's IDF1 slightly above 1 in 10 of the 444 SLAP-2M camera-sessions (at most 1.0049), which is an artifact of the scorer rather than better tracking.' Checked against `fig6_slap2m_fair_sleapnt_percam.csv` (10 of 444, max 1.00488) |
| S4 | Exact-match gate: 74 sessions and 11,726,640 camera-frames for every arm (already true; re-assert in the final build) | [x] done (2026-10-19 ~21:50, eric-mimicc-0-1): `figs/s4_frame_gate.py` -> `out/s4_frame_gate.json` PASSED. From `fig6_slap2m_fair_sleapnt_percam.csv` (Fig 6c's `slap2m_fair` source): LUC3D / SLEAP / ByteTrack each 74 sessions, 444 camera-sessions, 11,726,640 camera-frames; num_frames and GT num_objects identical per camera-session. Re-run in the final build |

## Phase X: cross-cutting

| ID | Item | Status |
|---|---|---|
| X1 | Fig 2F: link `fig4_anipose_md56pad.json` (exact 19,079,133 keypoints = LUC3D) in place of the unpadded deposit | [x] done in fig2c (2026-10-19 21:05): `fig4_anipose_b3.json` -> `fig4_anipose_md56pad.json`; both F arms 19,079,133 keypoints; tex numbers unchanged (2.15-2.34 px, 56/56, 56/56) |
| X2 | Fig 3 SLAP-2M greedy arm is tail-free by weight 0. Exhaustive drops the tail nodes. Show these are equivalent (target creation ignores `nodeWeights`) or rerun greedy with `--tail-nan` | [x] done (2026-10-19 20:52): default config 74/74 (B3) and the head-to-head camera subsets A2_C6 35/35, A3_C5 4/4, A4_C3 3/3 IDENTICAL with --tail-nan (`out/tailnan_check_arms_v105.json`). No rerun needed |
| X3 | Fig 2B/2D read the old `fig2.json` (Aug 12, own NumPy DLT). Its keypoint counts match the md56 export only to 0.1%. Under rule 7, regenerate on the md56 export exactly, or prove an exact match | [ ] checked 2026-10-19: no cross-arm mismatch. Placed 2C reads only fig4_by_views_md56. 2B/2D read fig2.json, single-method descriptive panels; 2D's 10 camera pairs share identical keypoints. The 0.1% count gap is stride 1 vs stride 15 sampling, not missing points. Remaining: one Methods sentence that 2B/2D use every frame and the authors' NumPy DLT (moved to P) |
| X4 | Fig 7H calibration timing | [x] closed with T3 (softened, not rerun) |
| X5 | `panels/fig6slapstale_reduction.py` writes `figures/fig6/fig6f_axes.json` even under FIG_TAG=c. Make the path tag-aware (and in `fig6_09`) | [x] done (2026-10-19: both panels use figures/fig6<FIG_TAG>/; main figures/fig6/fig6f_axes.json restored to HEAD; fig6c has its own copy) |
| X6 | Stale metadata: `fig3_exhaustive_bmimica_*` `denominator_note`; `fig8_methods_50_*` headers say `xv_experimental.js` and give no commit | [ ] corrections listed 2026-10-19 ~21:55 (not applied: both deposits are read by figures, so they are rewritten only with the final build, X7). (a) `fig3_exhaustive_bmimica_b3.json` (= `_c6b3`) denominator_note says '4.32M of 9.00M video frames ... full-session 45,021,960'; true b3 values: 9,738,707 clean of 10,084,734 video frames = 48,693,535 camera-frames (its own `camera_frames_computed`), and fig3c G/H are frame-matched to those same 48,693,535; the full-session denominator is 50,423,670. (b) `fig8_methods_50_b3.json` (= `_c6b3`, `_b3stale` same issue): `lucid_commit` absent, should be 2dc001fe (`/root/vast/eric/lucid-main-md56` HEAD, checked); `experimental_tracker` names `fig6-bench/xv_experimental.js` but `driver` is `fig3-bench/fig3_bench.mjs`; caveats still say '8 full sessions' (it is 56) |
| X7 | Decide the final build: one variant name, one tag, every link listed, `FIG_VARIANT_REQUIRE` set so a missing link fails loudly; builds Figs 2-7 together | [ ] decision |

## Phase P: paper

| ID | Item | Status |
|---|---|---|
| P1 | Tex Mouse-Dyad numbers all from b3 (L103, L150, L293, L347, L411; the r = 12 sentence; 68x; SLEAP/ByteTrack cross numbers) | [ ] 2026-10-20 (eric-mimicc-0-1): L413-417 rewritten on SLAP-2M (see log); L293 done (M4); L150 done by eric-mimic2. Remaining: the task-5 number sweep (audit running) |
| P2 | Tex timing numbers from T1/T2 (Fig 3F, Fig 2G, Abstract-adjacent claims) | [x] done 2026-10-20 (Fig 3F half on eric-mimic2, see log). Abstract fps are Eric's M1 in-app numbers, mimicc adds provenance |
| P3 | Fig 6 caption: new f (SLAP-2M staleness, % switch reduction), g y-axis 60-100, letters | [x] done (2026-10-19 ~22:10): caption F now describes fig6c f (SLAP-2M staleness, survival left, % fewer switches vs stale 0 right) and the footer reads 'F, all 74 SLAP-2M sessions, ~11.7 million camera frames'. Letters A-G match fig6c. g's 60-100 axis needed no caption change |
| P4 | Re-verify with a grep after every tex edit (Eric edits the tex at the same time) | [ ] standing |

## Split, 2026-10-20 (Eric: keep fig2c / fig3c / fig6c as the figures, change the tex to match)

Both hosts share /root/vast. Each session edits only its own tex lines and grep-verifies after every edit (P4).

**eric-mimic2-0-6 (owns Fig 3):**
1. 3F: point `panels/fig3_06_head_to_head.py` at `fig3_runtime_clean_b3.json` / `fig3_headtohead_clean_b3.json` under b3. fig3c F (built 20:27) still uses the old `fig3_runtime_b3.json` (one session, first 3,000 frames).
2. 3F gap: the clean run has no greedy time at 4x6 (the open-marker column). Short clean greedy-only sitting on the 3 four-animal sessions, nothing else of ours running on this host.
3. Rebuild fig3c. Tex: L148 (20x, 3.1/0.16 ms, 0.24 ms, >5 h), L150 (G/H, proposed edits section 1), L285 (3.1-5.4 ms; "Like LUC3D, it leaves out the four tail nodes" is wrong for Mouse-Dyad b3), Fig 3 caption tail sentence, L156 fig3.pdf -> fig3c.pdf (M1).

**eric-mimicc-0-1 (owns everything else in the tex):**
1. L413-417 staleness subsection (decision: re-ground on SLAP-2M = fig6c f).
2. L293 camera subsets (M4, proposed edits section 2).
3. L103 "16,030" / "14,694 frames per second" are NOT benchmarks: Eric measured them in the app (v1.0.5) in Chrome on his 16 GB Apple M1 MacBook Pro, with a console snippet. Keep them, and add the provenance sentence (FIX-CHECKLIST A1.3). Do not recompute from fig2c.
4. L484 fig6.pdf -> fig6c.pdf.
5. Last: X6 metadata, X7 final build + gates (S4 rerun).
6. Optional: T3 calibration sitting, only if Eric wants Fig 7H redone. Otherwise soften L435.

## Log

- 2026-10-20 ~04:20 UTC (eric-mimicc-0-1): HANDOFF-ericmimicc-2026-10-20 tasks 1-4 and 6 done in the tex (backup `out/md56_logs/luc3d_newest.before_mimicc_2026-10-20.tex`).
  - Task 1, staleness subsection (Eric approved the text and the new title 'Evicting stale evidence from the 3D anchor reduces identity switches'). Source `out/stale_sweep_slap2m.json` (74 sessions, 2dc001fe, every arm sync + 25 mm + r = 6, only N varies). Switches over 74 sessions 3,753 / 3,500 / 3,406 / 3,333 / 3,390 (N = 0/1/10/20/30). Mean cross IDF1 over the 42 multi-animal sessions 0.911 / 0.894 / 0.918 / 0.932 / 0.929 (N = 20 = the abstract's 0.932). Wilcoxon two-sided on per-session cross IDF1 vs N = 20 (computed from the deposit's per_session): vs 0 20 better / 6 worse P = 0.0124, vs 1 P = 0.0032 (multi; 0.0026 over 74), vs 10 P = 0.715, vs 30 P = 0.485. Mouse-Dyad b3 sentence from `fig8_methods_50_b3.json` + `_b3stale.json`: 110 vs 144, 4 better / 12 worse at N = 20, P = 0.0174 (rechecked). The old 'best re-tuning without eviction' comparison was dropped (no SLAP-2M equivalent). Methods anchor section updated to match (sweep on 74 SLAP-2M sessions, also run on 56 Mouse-Dyad; a semicolon removed).
  - Corpus lists: L241 Mouse-Dyad list now 'Supplementary Figure 6A' (F moved to SLAP-2M); L243 SLAP-2M list 'Supplementary Figure 6B to F'.
  - Task 2 (M4) done, see row.
  - Task 3: provenance sentence added at the end of Methods Software. Eric 2026-10-20: in-app, v1.0.5, Chrome, 16 GB Apple M1 MacBook Pro, console snippet, on a Mouse-Dyad session. No session id, Chrome version or averages recorded. 16,030 / 14,694 unchanged at L103 (the Introduction, not an abstract).
  - Task 4: L484 fig6.pdf -> fig6c.pdf. Caption letters A-G match the rendered fig6c (F = SLAP-2M staleness, 7/9/11/10%). NOTE `data/fig6c/fig6f_pr_switches.csv` holds the MOUSE-DYAD b3 sweep (56 sessions, 110/144), a leftover of `panels/fig6_07_pr_switches.py` under FIG_TAG=c. It is not what F draws (F reads `data/fig6slapstale/`). Clear it up in X7. `drafts/figs/` holds no figure PDFs, so `figures/fig6c/fig6c.pdf` must be uploaded as `figs/fig6c.pdf` wherever the tex compiles.
  - Task 6: Eric chose to soften L435, not rerun T3.
  - Found in the sweep, fixed (b3 rules 1, 5): L267 said the Mouse-Dyad pool was sleap-nn-filtered (>= 8 keypoints, score 0.85 / 0.55, OKS 0.5). On b3 both datasets use the body >= 5 pool with no sleap-nn filters (`MDB-B-SERIES-RESULTS`, `fig6_sleap_max2_retrack.py` B3_POOL). L275 said every mouse run gave the tail zero weight; on b3 Mouse-Dyad every node weighs 1 (`fig6_methods.py` MD_CFG=b3 `--no-exclude-tail`). L337 said SLEAP applied the pool's filters on Mouse-Dyad; on b3 it applies none (filter flags not passed). The ByteTrack sentence now says its Mouse-Dyad boxes include the tail (`fig6_bytetrack_max2.py` BYTE_B3).

- 2026-10-20 ~03:50 UTC (eric-mimic2-0-6): Fig 3 list done.
  - 4x6 greedy-only clean sitting (`T_A4C6=1`, new opt-in `--eligible-only` in `fig3_exhaustive.mjs`): 3 sessions x 100 frames x 3 rounds, 0.653 ms/frame, load ~11, nothing else of ours running.
  - `panels/fig3_06_head_to_head.py`: `FIG3F_CLEAN=1` reads the clean deposits. `FPS` 50 -> 30 (SLAP-2M is 30 fps). Footnote now in hours. fig3c rebuilt (`FIG_VARIANT=b3 FIG_TAG=c FIG3F_CLEAN=1`, log `out/md56_logs/FIG3C_clean3F_make_figures.log`). Only `data/fig3c/fig3e_head_to_head.csv` changed. Backup of the previous fig3c in `out/md56_logs/fig3c_before_clean3F_2026-10-20/`.
  - Timing audit: 294/294 calls frame-matched, tail flags right, order alternated, outside load median 13.1 (max 21.8). Caveat found: each greedy call is a fresh node process timed with Date.now(), so JIT warm-up is inside the greedy time. Same session, same frames: A4_C3 0.47 ms at K = 100 vs 0.21 ms at 10x more frames vs 0.16 ms on 3,000 consecutive frames; A2_C5 0.146 vs 0.124 vs 0.132. So the clean greedy numbers OVERSTATE LUC3D's cost (up to ~2x at the 100-frame cells). Eric: proceed. Stated in Methods.
  - Tex (backup `out/md56_logs/luc3d_newest.before_mimic2_fig3_2026-10-20.tex`): L144 + L146 (5.2M -> 10.1M frames, 62/58 -> 23/15 sessions with no misgrouped frame, 0.024/0.039% -> 0.022/0.030%), L148 (17x, 4.0 / 0.24 ms, 4x6 0.65 ms, >5 h holds: 678 s x 30 = 5.6 h), L150 (G/H, proposed section 1, numbers rechecked against `data/fig3c/fig3g_sweep_framematched.csv`), fig3.pdf -> fig3c.pdf, caption E median "below 0.01%" (max 4.1% / 3.1% still right), caption footer (10.1M, F sampling, tail IN for Mouse-Dyad), L285-289 (tail sentence, 10.1M eligible, 4.0-5.5 ms, new timing-method sentences, G/H frame-matched sentence).

- 2026-10-19 22:43 UTC: T1 clean rerun done, exit 0, 294/294 calls, every gate passed, nothing of ours ran alongside. Greedy vs exhaustive per frame (median of 3 rounds): A2_C5 Mouse-Dyad 0.238 vs 4.00 ms (16.8x); A2_C6 SLAP-2M 0.276 vs 5.45 ms (19.7x); A3_C5 0.500 vs 887 ms (1,774x); A4_C3 0.473 vs 1,539 ms (3,250x). Host 1-min load at call start median 13.1, max 21.8, all from outside this container. A3 greedy spread 35% is round 0 alone (outside load 14-16, 100 sub-ms frames per session); rounds 1-2 agree. Within 1-4% of the overlapped sitting, so the sweep barely moved it, but only this run is reported.

- 2026-10-19 22:15 UTC (eric-mimicc-0-1): tex edits (backup `figs/out/md56_logs/luc3d_newest.before_P1_2026-10-19.tex`). Applied: L103 'mean cross-view IDF1 of 0.873 on Mouse-Dyad-10M' -> 0.968; L411 '0.872 within view and 0.873 across' -> '0.968 within view and 0.968 across', '(SLEAP 0.661 to 0.148, ByteTrack 0.755 to 0.177)' -> '(SLEAP 0.830 to 0.186, ByteTrack 0.825 to 0.191)' (source data/fig6c/fig6a_within_vs_cross_variant.csv); S3 sentence added to the ByteTrack Methods paragraph; Fig 6 caption F + footer rewritten for the SLAP-2M staleness panel (P3). Drafted, NOT applied: L150, L293, L413-417 in `P1-M4-PROPOSED-EDITS-2026-10-19.md`. Open question for Eric: on b3 Mouse-Dyad, no eviction (stale 0) beats the default N = 20 (110 vs 144 switches, cross IDF1 0.986 vs 0.968, 12 vs 4 sessions, P = 0.017), so the 'stale evidence is the dominant switch mechanism' subsection needs re-grounding (SLAP-2M, where eviction helps 11%) or rewriting. Also unchecked: L103 '16,030 frames per second' triangulation (no source found; Fig 2G DLT changed).

- 2026-10-19 21:50 UTC (eric-mimicc-0-1): S4 PASSED (see table). Plan rows now carry [x]/[ ] checkboxes (Eric).

- 2026-10-19 21:35 UTC (eric-mimicc-0-1): M3 done (see table). Session stopped here: remaining M1, M4, P1, P3, S3, S4, X6, X7 untouched. Nothing running on this box.

- 2026-10-19 21:20 UTC (eric-mimicc-0-1): S2 + X2 + M6 closed (see table). Fig 3F belongs to the main-box T1 session: a Fig 3F clean-timing edit made here was reverted (git checkout) so the two sessions do not both edit `panels/fig3_06_head_to_head.py`. Nothing is running on eric-mimicc-0-1. Remaining: T1 -> 3F rebuild (main box), M1, M3 wiring, M4, P1, P3, S3, S4, X6, X7.

- 2026-10-19 21:00 UTC (eric-mimicc-0-1): P2 Fig 2 half done (Eric: "2c is what i am looking for"). luc3d_newest.tex now includes figs/fig2c.pdf and quotes T2: 32x / 5.0x, DLT 0.95 us, caption G = same 200,010 keypoints for every solver, RANSAC 133x its linear solver, undistortion 0.42 / 2.19 us. Only 2G's CSV differs between data/fig2 and data/fig2c; every other Fig 2 number is unchanged. Fig 3F half of P2 waits for T1 (to be rerun on the main box).

- 2026-10-19 20:45 UTC (eric-mimicc-0-1): SFMB3 ran on eric-mimicc-0-1, NOT on the main box where T1/T2 run. The two are separate hosts: T2_load.log median 12.5 / max 23.6 over 18:09-18:57, while SFMB3's 40 workers at ~97% CPU alone would have put a shared kernel's load above 40. So T2 (and the first T1 sitting, load ~12-13) were NOT overlapped by SFMB3; the 20:30 premise was wrong. T2 stands as the Fig 2G source. Built figures/fig2c (FIG_VARIANT=b3, FIG_TAG=c) with fig2g_retime_all_b3.json -> md56T2: DLT 0.95, Anipose linear 30.56 (32.1x), refined 28.94, optim 144.41 (5.0x). T1 relaunch (main box, 20:30) left running; it should agree with the _sweepoverlap sitting.

- 2026-10-19 20:30 UTC: Eric confirmed SFMB3 ran on this machine, so the first T1 sitting was not quiet. T1's process gate missed it because `BENCH_MARKERS` had no entry for `fig3_sweep_framematched`; markers added (fig3_sweep, framematched, frame_matched, fig3_scale, fig3_trackers, fig2g_retime, timed_b.py, run_all_b). Old outputs renamed `*_sweepoverlap`. T1 relaunched (98 cells, 3 rounds, nothing else of ours running, load 12.5). Eric: Fig 3F is the priority; calibration timing (T3) is not.

- 2026-10-19 20:25 UTC: status check. Nothing of ours running. The SFMB3 framematched rescoring (40 workers) ran ~15:28-20:20 UTC, wrote its d25-stale20 deposit and exited normally. Its cache files were written every hour through T1 (~15:55-18:08) and T2 (~18:09-18:57). No session here launched it and pgrep in this container never saw it, so it ran from somewhere else. If it ran on this host, it is part of the '~11 cores outside load' and T1/T2 were not on a quiet machine. Open question for Eric before P2 uses T1/T2 numbers. T3 prep finished 19:14; the sitting has not run.

- 2026-10-19 ~19:05 UTC: T3 prep started. `calib_b/transcode_b.sh` had a latent bug: `ffmpeg -i` exits 1, and under `set -e -o pipefail` the codec probe silently killed the script. Fixed by ignoring the probe's status and failing on an empty codec instead. M5 and X5 done while prep ran (code only).

- 2026-10-19 18:57 UTC: T2 done, restarted once so nothing of ours overlapped it. Every solver on the same 200,010 keypoints, 5 interleaved rounds, single-threaded, best of rounds, µs/keypoint: LUC3D DLT 0.95, Anipose linear 30.56 (32.1x), LUC3D refined 28.94, Anipose optim no-smoothing 144.41 (5.0x), default 139.58 (4.8x). RANSAC on the same keypoints 133x DLT (tex says 75x). Undistortion 0.42 µs (Anipose). Host 1-min load median 12.5, max 23.6 (outside spike). Round 1's optim_nosmooth (264) is an outlier; best-of excludes it. The tex numbers to change are in P2.

- 2026-10-19 18:08 UTC: T1 done (exit 0), restarted from scratch twice so nothing of ours ran alongside it. Identical frames in both arms, 3 rounds, median, host load ~12-13 throughout (outside this container). Greedy vs exhaustive per frame:
  - A2_C5 Mouse-Dyad (b3, tail in): 0.246 ms vs 3.994 ms, 16.2x (56 sessions x 1,000 frames).
  - A2_C6 SLAP-2M: 0.280 vs 5.441 ms, 19.4x (35 sessions, 33,919 frames).
  - A3_C5: 0.485 ms vs 884 ms, 1,824x.
  - A4_C3: 0.463 ms vs 1,543 ms, 3,329x.
  - Round-to-round spread: greedy 11-17% (sub-ms solves, ms timer, host noise), exhaustive 2-7%.

- 2026-10-19: Eric chose to rerun Fig 7H in a quiet sitting (T3), after T1 and T2. The `calib_b` scripts and inputs were checked; nothing launched.
- 2026-10-19: T1 code. Added opt-in `--frame-list` to `fig3-bench/fig3_exhaustive.mjs` (throws if a listed frame is not eligible). New `figs/fig3f_timing_clean.py`. Smoke run (1 session per cell, K = 20) passed every gate: identical frames in both arms, tail IN for Mouse-Dyad and OUT for SLAP-2M, 2dc001fe. Host load at start was ~12 (outside this container; nothing of ours running). Full sitting launched: 98 sessions, 3 rounds.
- 2026-10-19: plan written from the audit. Before this: fig6c reverted to the old layout; f = SLAP-2M switch reduction; g y-axis 60-100; fig6c b-d use sleapnt (S1).
