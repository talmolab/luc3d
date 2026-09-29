# Preprint audit checklist: `luc3d_newest.tex`

Built 2026-09-29 from `PREPRINT-AUDIT-FINDINGS.md` against the 03:10 `luc3d_newest.tex`; status re-checked against the 06:04 version. Same layout as the copydesk checklist, with three tiers in manuscript order. Each entry gives **Issue** → **Fix** → **Current** (the full sentence copied verbatim from the `.tex` by script, so Ctrl-F finds it) → **Replace with** (paste-ready). The generator aborts if any Current is not found exactly once. The evidence for every item, with its reproduce command, is in `PREPRINT-AUDIT-FINDINGS.md` (the ID in brackets).

**Progress:** 23 / 85 text edits (section 1 complete as of the 06:04 `.tex`; L406 and L414 resolved without an edit by the 4.13 re-run; must-false 11 · must-mismatch 46 · should 24), plus the non-text items in sections 4–7.

---


## 1. Must fix: false as written (retraction risk) (11 / 11)

- [X] **L112** · ⚠ Must fix · false (A8) · **applied 2026-09-29 06:04**
  - **Issue:** The 3D render is no longer drawn from Camera 0's viewpoint (it uses a corner view), and the left tile shows the 2D detections coloured by identity.
  - **Fix:** Describes the tile as it is drawn. Evidence: `sed -n 33,36p figs/panels/fig1_03_reconstruction.py`.
  - **Current:** `In Figure~\ref{fig1}D, we next show how LUC3D triangulates that frame and fills all 45 of its 3D keypoints, overlaying the reconstruction onto Camera 0's perspective (\textit{left}) so that it can be compared directly with that camera's video.`
  - **Replace with:** `In Figure~\ref{fig1}D, we next show how LUC3D triangulates that frame and fills all 45 of its 3D keypoints, shown beside the 2D detections in one camera (\textit{left}) so that it can be compared directly with that camera's video.`
- [X] **L131** · ⚠ Must fix · false (A3) · **applied 2026-09-29 06:04**
  - **Issue:** Fig 2E top is scored against the held-out camera's raw detections. No ground-truth 3D enters it (`figs/panels/fig2_12_accuracy_vs_cameras.py` docstring).
  - **Fix:** Deletes "compared with ground truth".
  - **Current:** `Increasing the number of contributing views leads to more accurate 3D estimates compared with ground truth.`
  - **Replace with:** `Increasing the number of contributing views leads to more accurate 3D estimates.`
- [X] **L136** · ⚠ Must fix · false (A4) · **applied 2026-09-29 06:04**
  - **Issue:** Fig 2G caption. Only the two LUC3D bars were timed on 17,013,412 keypoints. Anipose linear used 200,000 and Anipose optim 345,000 (`figs/out/fig4_anipose.json` timing).
  - **Fix:** States each bar's keypoint count.
  - **Current:** `$n = 50$ Mouse-Dyad-10M sessions at every 15th frame, $\sim$17 million keypoints, the same keypoints in every column.}`
  - **Replace with:** `$n = 50$ Mouse-Dyad-10M sessions at every 15th frame, $\sim$17 million keypoints for LUC3D, with Anipose timed on 200,000 (linear) and 345,000 (optimized) keypoints.}`
- [X] **L146** · ⚠ Must fix · false (A1) · **applied 2026-09-29 06:04**
  - **Issue:** The 4-animal × 6-camera bound is a SLAP-2M configuration (`figs/out/fig3_headtohead.json`: `A4_C6_slap2m_hard`, dataset SLAP-2M). Mouse-Dyad-10M is 2 animals × 5 cameras, where exhaustive takes 11.5 ms per frame. 30 × 1,980.9 s = 16.5 h.
  - **Fix:** Correct dataset and rate.
  - **Current:** `Even at this bound, one second of 150 fps Mouse-Dyad-10M video would take more than three days to process.`
  - **Replace with:** `Even at this bound, one second of 30 fps SLAP-2M video would take more than 16 hours to process.`
- [X] **L256** · ⚠ Must fix · false (A5) · **applied 2026-09-29 06:04**
  - **Issue:** The 18-camera calibration rig is 1680×1200 (L402) and Panopticon is 1920×1200 (L451).
  - **Fix:** Limits the claim to the pose datasets.
  - **Current:** `The video resolution for all datasets is 1280x1024 pixels.`
  - **Replace with:** `The video resolution for all three pose datasets is 1280x1024 pixels.`
- [X] **L256** · ⚠ Must fix · false (A6) · **applied your way ("except the 13 sessions which are 60 FPS"; optional polish: "except 13 sessions, which are 60 FPS") 2026-09-29 06:04**
  - **Issue:** 13 of the 74 sessions (every 2022-10-19 session) are 60 fps. This was checked on the videos with cv2 and in the master sheet (frames/duration = 60.0 for 13 sessions).
  - **Fix:** States both rates.
  - **Current:** `The SLAP-2M video data has a frame rate of 30 FPS.`
  - **Replace with:** `The SLAP-2M video data has a frame rate of 30 FPS, except the 13 sessions recorded on 19 October 2022, which are 60 FPS.`
- [X] **L286** · ⚠ Must fix · false (A10) · **applied 2026-09-29 06:04**
  - **Issue:** The shipped code does not stop a long-lost identity from competing. Eviction deletes stale detections, but the target keeps its last 3D anchor (`_retriangulate` keeps `points3d` when fewer than 2 detections remain, `pose/cross-view-tracker.js` L160–168), and the 3D term has no decay. A probe run gave full 3D score (36.0 of 36) after 100 empty frames. The measured switch reduction stands; the stated mechanism does not.
  - **Fix:** Describes what eviction actually does. Pairs with the L395 item. Do not change the tracker before Friday (every tracking number would move).
  - **Current:** `An anchor is therefore only ever triangulated from cameras that saw the animal recently, and every camera is scored against a recent anchor, which is what prevents a long-lost identity from competing for assignments at full strength.`
  - **Replace with:** `An anchor is therefore only ever triangulated from cameras that saw the animal recently, so views that have lost the animal no longer pull the anchor toward stale positions.`
- [X] **L300** · ⚠ Must fix · false (A7) · **applied 2026-09-29 06:04**
  - **Issue:** On `main` (PR #224) the solver is titled "Refined (Ref)" (settings), the menu item reads "Ref" and the info panel "Refined". The deployed site and this branch still show "BA", so deploy `main` before release (release step R3).
  - **Fix:** Matches the labels on `main`.
  - **Current:** ``` The application's menu labels the non-linear solver as ``Refined''. ```
  - **Replace with:** ``` The application labels the non-linear solver ``Refined (Ref)''. ```
- [X] **L395** · ⚠ Must fix · number (A10b + B9) · **applied your way ("much earlier") 2026-09-29 06:04**
  - **Issue:** The sentence is true for the tracker without eviction. Only "minutes" is unsupported: the longest measured anchor age is 8,652 frames = 57.7 s (`figs/out/fig8_diag_anchor_age.json`, 8 sessions). The false mechanism claim (that eviction stops a fully lost identity from competing) is stated explicitly at L286 and fixed there.
  - **Fix:** Drops "minutes" only. ("seconds earlier" is also accurate if you want a time scale.)
  - **Current:** `When an identity's 3D anchor retains detections without a limit, an identity that lost its animal minutes earlier continues to compete for assignments at full strength from the last position at which it was seen.`
  - **Replace with:** `When an identity's 3D anchor retains detections without a limit, an identity that lost its animal earlier continues to compete for assignments at full strength from the last position at which it was seen.`
- [x] **L406** · Must fix · **resolved by the 4.13 re-run, no text change** (A9)
  - **Issue:** The controls behind this sentence had been run with aniposelib on OpenCV 5.0.0. **Re-run 2026-09-29 with both tools on OpenCV 4.13** (`figs/fig7_calib_controls_413.sh`; aniposelib's dependency had silently installed OpenCV 5, so the run now refuses to start unless cv2 is exactly 4.13.0). All arms were scored on the same 652,540 observations: Anipose default 1.252, equal frames 1.133 (−0.12), same reference 1.252 (no change), both 1.131, calibrat3 0.188 px. Deposit: `figs/data/fig7/fig7s3_equal_frames.csv` (the OpenCV 5 table is kept as `fig7s3_equal_frames_opencv5.csv`).
  - **Fix:** **No edit.** L406 describes the control as run, and it now ran on 4.13, consistent with L404.
  - **Current:** `Because Anipose's default gives it the larger frame budget, aniposelib was also re-solved on only the frames calibrat3 used.`
  - **Replace with:** *(no change: keep the sentence as it is)*
- [x] **L414** · Must fix · **resolved by the 4.13 re-run, no text change** (A9b)
  - **Issue:** The controls behind this sentence had been run with aniposelib on OpenCV 5.0.0. **Re-run 2026-09-29 with both tools on OpenCV 4.13** (`figs/fig7_calib_controls_413.sh`; aniposelib's dependency had silently installed OpenCV 5, so the run now refuses to start unless cv2 is exactly 4.13.0). All arms were scored on the same 652,540 observations: Anipose default 1.252, equal frames 1.133 (−0.12), same reference 1.252 (no change), both 1.131, calibrat3 0.188 px. Deposit: `figs/data/fig7/fig7s3_equal_frames.csv` (the OpenCV 5 table is kept as `fig7s3_equal_frames_opencv5.csv`). Every claim in this sentence holds on 4.13: equal frames lowers aniposelib's median by about 0.1 px (0.12), the same reference camera has no effect (0.000), and calibrat3's median is less than half of aniposelib's in both cases (0.188 against 1.133 and 1.131).
  - **Fix:** **No edit.** The sentence reports only relative effects, and all three reproduce on 4.13. Note that the re-run used a new H.264 transcode of the 18-camera recording (the original transcode was lost), so its absolute defaults (1.252 / 0.188) differ slightly from the figure's (1.280 / 0.212). That is why the sentence must not quote absolute numbers from the control run.
  - **Current:** `Restricting aniposelib to the frames calibrat3 used lowered its median by about 0.1 pixels on the 18-camera dataset, giving it the same reference camera had no effect, and calibrat3's median remained less than half of aniposelib's in both cases.`
  - **Replace with:** *(no change: keep the sentence as it is)*

## 2. Must fix: mismatches, prioritized by how likely a reviewer is to flag them (12 / 50)


### 2A. Most serious: wrong numbers, statistics or method statements a reviewer can check (12 / 24)

In priority order. Each states a number or method that the data, the figure or the code contradicts.

- [X] **L154** · Must fix · number (B50) · **#1: the headline speed-ups were overstated**
  - **Issue:** Re-timed with one protocol for every bar: Anipose linear 28.0, LUC3D DLT 7.4, Anipose optim 139.3, LUC3D refined 41.7 µs per keypoint, so the speed-ups are **3.8× and 3.3×**, not 4.6× and 5.2×. Source: `figs/out/fig2g_retime_all.json` (`figs/fig2g_retime_all.py` + `figs/fig2g_retime_extra.py`, 2026-09-29). All bars timed in one sitting, interleaved over 5 rounds, best round each, single-threaded (NUMBA_NUM_THREADS = 1; cpu/wall = 1.0 measured), aniposelib 0.7.2 (no JAX installed), LUC3D on `origin/main`'s `pose/` under Node 26.10, same inputs and scopes as before. The published Anipose-optim bar (228.8) was one run per size with library defaults on a shared, loaded host; every re-timing since is about 1.6× faster. Smoothing on or off changes the cost by <1% (138.8 vs 139.3).
  - **Fix:** New speed-ups. Fig 2G (re-rendered) now prints 3.8× and 3.3×.
  - **Current:** `LUC3D's solvers are 4.6 and 5.2 times faster per keypoint than the corresponding aniposelib paths (Figure~\ref{fig2}G).`
  - **Replace with:** `LUC3D's solvers are 3.8 and 3.3 times faster per keypoint than the corresponding aniposelib paths (Figure~\ref{fig2}G).`
- [X] **L306** · Must fix · protocol (B31) · **#2: timing protocol, matches the new bars**
  - **Issue:** The previous sentence described the mixed protocol (best of three for aniposelib, one pass for LUC3D). All bars are now timed the same way. Source: `figs/out/fig2g_retime_all.json` (`figs/fig2g_retime_all.py` + `figs/fig2g_retime_extra.py`, 2026-09-29). All bars timed in one sitting, interleaved over 5 rounds, best round each, single-threaded (NUMBA_NUM_THREADS = 1; cpu/wall = 1.0 measured), aniposelib 0.7.2 (no JAX installed), LUC3D on `origin/main`'s `pose/` under Node 26.10, same inputs and scopes as before. The published Anipose-optim bar (228.8) was one run per size with library defaults on a shared, loaded host; every re-timing since is about 1.6× faster. Smoothing on or off changes the cost by <1% (138.8 vs 139.3).
  - **Fix:** Describes the protocol actually used.
  - **Current:** `The solvers reported here were timed in process under single-threaded Node 26 with \texttt{performance.now} around each call and aniposelib with \texttt{time.perf\_counter}, taking the best of three runs for aniposelib, while the LUC3D bars are one pass over the $\sim$17 million keypoints (a best-of-three recheck on the 200,000 keypoints used for Anipose is within 11\%).`
  - **Replace with:** `The solvers reported here were timed in one sitting under single-threaded Node 26 with \texttt{performance.now} around each call and aniposelib with \texttt{time.perf\_counter}, interleaved over five rounds and taking the best round for each.`
- [X] **L306** · Must fix · number (B51) · **#3: undistortion costs from the same sitting**
  - **Issue:** 0.57 and 1.16 came from older, different runs. In the same sitting they are 0.44 (aniposelib) and 1.31 (LUC3D) µs per keypoint. Source: `figs/out/fig2g_retime_all.json` (`figs/fig2g_retime_all.py` + `figs/fig2g_retime_extra.py`, 2026-09-29). All bars timed in one sitting, interleaved over 5 rounds, best round each, single-threaded (NUMBA_NUM_THREADS = 1; cpu/wall = 1.0 measured), aniposelib 0.7.2 (no JAX installed), LUC3D on `origin/main`'s `pose/` under Node 26.10, same inputs and scopes as before. The published Anipose-optim bar (228.8) was one run per size with library defaults on a shared, loaded host; every re-timing since is about 1.6× faster. Smoothing on or off changes the cost by <1% (138.8 vs 139.3).
  - **Fix:** Same-sitting numbers.
  - **Current:** `The excluded undistortion is 0.57 microseconds per keypoint for aniposelib and 1.16 for this work.`
  - **Replace with:** `The excluded undistortion is 0.44 microseconds per keypoint for aniposelib and 1.31 for this work.`
- [X] **L304** · Must fix · number (B52) · **#4: RANSAC cost from the same sitting**
  - **Issue:** 2,467 µs and "85 times" came from an older run. In the same sitting RANSAC is 2,105 µs per keypoint (n = 5,000), which is 75× the default linear path (28.0). Source: `figs/out/fig2g_retime_all.json` (`figs/fig2g_retime_all.py` + `figs/fig2g_retime_extra.py`, 2026-09-29). All bars timed in one sitting, interleaved over 5 rounds, best round each, single-threaded (NUMBA_NUM_THREADS = 1; cpu/wall = 1.0 measured), aniposelib 0.7.2 (no JAX installed), LUC3D on `origin/main`'s `pose/` under Node 26.10, same inputs and scopes as before. The published Anipose-optim bar (228.8) was one run per size with library defaults on a shared, loaded host; every re-timing since is about 1.6× faster. Smoothing on or off changes the cost by <1% (138.8 vs 139.3).
  - **Fix:** Same-sitting numbers.
  - **Current:** `Enabling the library's RANSAC path costs 2,467 microseconds per keypoint, which is 85 times the default path, so it was impractical to include in the figure.`
  - **Replace with:** `Enabling the library's RANSAC path costs 2,105 microseconds per keypoint, which is 75 times the default path, so it was impractical to include in the figure.`
- [X] **L136** · Must fix · caption (B53) · **#5: Fig 2G keypoint counts, matches the new bars**
  - **Issue:** Every bar is now timed on the same 200,000 keypoints, except Anipose's optimized path (345,000), which is one global solve per session and needs a session-sized input. Replaces your earlier edit of this sentence. Source: `figs/out/fig2g_retime_all.json` (`figs/fig2g_retime_all.py` + `figs/fig2g_retime_extra.py`, 2026-09-29). All bars timed in one sitting, interleaved over 5 rounds, best round each, single-threaded (NUMBA_NUM_THREADS = 1; cpu/wall = 1.0 measured), aniposelib 0.7.2 (no JAX installed), LUC3D on `origin/main`'s `pose/` under Node 26.10, same inputs and scopes as before. The published Anipose-optim bar (228.8) was one run per size with library defaults on a shared, loaded host; every re-timing since is about 1.6× faster. Smoothing on or off changes the cost by <1% (138.8 vs 139.3).
  - **Fix:** States the counts actually timed.
  - **Current:** `$n = 50$ Mouse-Dyad-10M sessions at every 15th frame, $\sim$17 million keypoints for LUC3D, with Anipose timed on 200,000 (linear) and 345,000 (optimized) keypoints.}`
  - **Replace with:** `$n = 50$ Mouse-Dyad-10M sessions at every 15th frame, each solver timed on the same 200,000 keypoints (345,000 for Anipose's optimized path, which solves a whole session at once).}`
- [ ] **L136** · Must fix · caption (B54) · **#6: Fig 2E bottom now shows both solvers**
  - **Issue:** The bottom axis now plots both solvers (2026-09-29): DLT 2.06 → 1.71 px (−0.345, lower in 50/50) and refined 1.61 → 1.52 px (−0.095, lower in 50/50). Each solver drops the view that fits its own solution worst, and both are scored on the kept views. Bars are a t-based 95% CI of the mean, while the caption's CI sentence describes the median CI of the top axis. Source: `figs/fig2_solvers_robust_sessions.mjs` (refined arm added; DLT columns unchanged, gate vs `fig4.json` passed), `figs/data/fig2/` CSVs.
  - **Fix:** Names both solvers and the interval.
  - **Current:** `Reprojection error in the kept views, all views in the solve compared with the same solve with the worst view dropped (bottom).`
  - **Replace with:** `Reprojection error in the kept views, each solver's all-view solve compared with the same solver with its worst view dropped, mean and t-based 95\% CI (bottom).`
- [X] **L354** · Must fix · mismatch (B8) · **#7: a statistics statement the figure contradicts (panel C has no CI; LUC3D CI is not bootstrapped)**
  - **Issue:** Panel C shows boxes (median, IQR, 1.5×IQR), not a CI. In panel A, the LUC3D interval is a normal approximation (1.96·sd/√n, `figs/fig6_variant_tracker.py`); only SLEAP and ByteTrack are bootstrapped.
  - **Fix:** Drops C and "bootstrap". Pairs with the L429 caption item.
  - **Current:** `The paired comparisons in Supplementary Figure~\ref{fig6}A and C report 95\% bootstrap confidence intervals over sessions.`
  - **Replace with:** `The comparisons in Supplementary Figure~\ref{fig6}A report 95\% confidence intervals over sessions.`
- [X] **L429** · Must fix · mismatch (B16) · **#8: same bootstrap claim, in the caption a reviewer reads first**
  - **Issue:** The LUC3D interval is a normal approximation, not a bootstrap (see L354). This also fixes the printed "+-".
  - **Fix:** "bootstrap" dropped; ± typeset.
  - **Current:** `\caption{\textbf{Cross-view identity, and the fresh-anchor staleness horizon.} \textbf{A}, Within-view and cross-view IDF1 for LUC3D, SLEAP, ByteTrack (mean +- 95\% bootstrap CI).`
  - **Replace with:** `\caption{\textbf{Cross-view identity, and the fresh-anchor staleness horizon.} \textbf{A}, Within-view and cross-view IDF1 for LUC3D, SLEAP, ByteTrack (mean $\pm$ 95\% CI).`
- [X] **L186** · Must fix · wrong panel (B3) · **#9: numbers quoted for panel C are panel E's; anyone reading the panel sees different values**
  - **Issue:** 5.3 and 57.7 are panel E's per-session means (`fig5e_detection_quality.csv` .0534/.5770). The sentence follows the Fig 5C citation, and C's pooled rates are 5.38/57.07 (its caption quotes 57.1).
  - **Fix:** Cites the panel the numbers come from.
  - **Current:** `From the easiest stratum to the hardest, measured on every frame of all 74 sessions, the per-view miss rate rises 10.8-fold, from 5.3 to 57.7\%.`
  - **Replace with:** `From the easiest stratum to the hardest, measured on every frame of all 74 sessions, the per-view miss rate rises 10.8-fold, from 5.3 to 57.7\% (Figure~\ref{fig5}E).`
- [X] **L167** · Must fix · number (B1) · **#10: number disagrees with the deposited data (5.2)**
  - **Issue:** The peak is 5.2477 (`figs/data/fig4/fig4g_rear_coupling.csv` female_p50 max).
  - **Fix:** 5.3 → 5.2.
  - **Current:** `The probability of the female's rearing rises prior to the male onset, reaches 4.7 times the baseline rate when he starts, and peaks at 5.3 times a third of a second later.`
  - **Replace with:** `The probability of the female's rearing rises prior to the male onset, reaches 4.7 times the baseline rate when he starts, and peaks at 5.2 times a third of a second later.`
- [X] **L180** · Must fix · number (B1b) · **#11: same number in the caption**
  - **Issue:** Same peak as L167: 5.2477.
  - **Fix:** 5.3 → 5.2.
  - **Current:** `Around the male onset, the female is already $4.7\times$ above chance rate at lag 0, peaking at $5.3\times$ a third of a second later (right).`
  - **Replace with:** `Around the male onset, the female is already $4.7\times$ above chance rate at lag 0, peaking at $5.2\times$ a third of a second later (right).`
- [X] **L180** · Must fix · denominator (B2) · **#12: 80% is only true of displays with an initiator; of all 539 it is 79.4%**
  - **Issue:** 80% is 428 of the 535 displays with an initiator. Of all 539 it is 79.4% (`figs/out/fig5_upright.json` events: initiator 1→428, 0→107, none→4).
  - **Fix:** Names the denominator.
  - **Current:** `\caption{\textbf{Behavioral analysis of social rearing.} Two mice rear together face to face; the female starts 80\% of the displays and the male joins in.`
  - **Replace with:** `\caption{\textbf{Behavioral analysis of social rearing.} Two mice rear together face to face; the female starts 80\% of the displays with a leader and the male joins in.`
- [X] **L171** · Must fix · mismatch (B23) · **#13: 0.83 is the share of all displays, not of initiations (0.857)**
  - **Issue:** 0.826 is the share of all displays (ties in the denominator). Over initiated displays it is 0.857 (scratchpad `chk4_output.txt`).
  - **Fix:** Names the denominator actually used.
  - **Current:** `Over the 23 sessions with at least six displays, the female's median share of initiations is 0.83 (paired Wilcoxon $P = 2.7 \times 10^{-5}$, Figure~\ref{fig4}F).`
  - **Replace with:** `Over the 23 sessions with at least six displays, the female's median share of displays is 0.83 (paired Wilcoxon $P = 2.7 \times 10^{-5}$, Figure~\ref{fig4}F).`
- [X] **L338** · Must fix · number (B7) · **#14: 13 SLAP-2M sessions are 60 fps, so "2 s at 30 fps" is wrong for them**
  - **Issue:** 13 SLAP-2M sessions are 60 fps (see L256).
  - **Fix:** Both rates.
  - **Current:** `SLEAP by default maintains an unbounded track pool, and ByteTrack, as run in the benchmark, retires any track lost for more than 60 frames, which is 2~s at SLAP-2M's 30 fps and 0.4~s at Mouse-Dyad-10M's 150 fps.`
  - **Replace with:** `SLEAP by default maintains an unbounded track pool, and ByteTrack, as run in the benchmark, retires any track lost for more than 60 frames, which is 1 to 2~s at SLAP-2M's 60 and 30 fps and 0.4~s at Mouse-Dyad-10M's 150 fps.`
- [X] **L338** · Must fix · mismatch (B7b) · **#15: SLAP-2M sessions are not 20 minutes, and 60 frames was not ByteTrack's default**
  - **Issue:** SLAP-2M sessions run 1–60 min (median about 10); only Mouse-Dyad-10M is about 20 min. The 60-frame ByteTrack buffer was the benchmark's tuned value, not the library default (30).
  - **Fix:** Drops the wrong length and "defaults".
  - **Current:** `Both defaults fragment identities on 20-minute sessions.`
  - **Replace with:** `Both original settings fragment identities on long sessions.`
- [X] **L342** · Must fix · mismatch (B33) · **#16: calls the 60-frame buffer ByteTrack's default; the library default is 30**
  - **Issue:** The library default is `lost_track_buffer = 30`. 60 was the benchmark's tuned value (supervision `ByteTrack.__init__`; `run_bytetrack_bench.py`).
  - **Fix:** Names the setting.
  - **Current:** `ByteTrack default setting often prematurely retires tracks leading to poor performance, so track retirement was disabled by setting \texttt{lost\_track\_buffer} to the session length.`
  - **Replace with:** `ByteTrack's original 60-frame buffer often prematurely retires tracks leading to poor performance, so track retirement was disabled by setting \texttt{lost\_track\_buffer} to the session length.`
- [X] **L175** · Must fix · mismatch (B24) · **#17: the threshold is in body lengths, not body height**
  - **Issue:** The rearing threshold is 0.75 body lengths (`figs/fig4_upright.py`; `figs/fig4_controls.py` docstring).
  - **Fix:** height → length.
  - **Current:** `Another alternative is that the result is an artifact of the per-animal threshold based on body height.`
  - **Replace with:** `Another alternative is that the result is an artifact of the per-animal threshold based on body length.`
- [X] **L278** · Must fix · mismatch (B10) · **#18: describes the tracker as it was before the sync fix (code contradicts it)**
  - **Issue:** Describes the tracker before the sync fix. Now every camera is scored against the same frame-start targets, and targets are re-triangulated at frame end (`pose/cross-view-tracker.js` L150–158, L281–287).
  - **Fix:** Describes the shipped order.
  - **Current:** `For each frame the application maintains a set of 3D targets and solves one Hungarian assignment per camera, committing each camera's assignment before the next is solved, at a cost of $O(C \cdot A^3)$ for $A$ animals and $C$ cameras.`
  - **Replace with:** `For each frame the application maintains a set of 3D targets and solves one Hungarian assignment per camera against the same frame-start targets, re-triangulating once all cameras are assigned, at a cost of $O(C \cdot A^3)$ for $A$ animals and $C$ cameras.`
- [ ] **L142** · Must fix · mismatch (B30) · **#19: same pre-sync description in the Results**
  - **Issue:** Reads as if each camera's match changes the next camera's cost. Since the sync fix it does not: every camera in a frame sees the same frame-start targets (`pose/cross-view-tracker.js` L150–158).
  - **Fix:** Adds the frame-start qualifier.
  - **Current:** `Following \citet{Chen2020}, LUC3D instead solves one Hungarian assignment per camera and commits it before moving on to the next, at a cost of $C \cdot A^3$ (the greedy Hungarian approach, Figure~\ref{fig3}A).`
  - **Replace with:** `Following \citet{Chen2020}, LUC3D instead solves one Hungarian assignment per camera and commits it before moving on to the next, with every camera scored against the same frame-start targets, at a cost of $C \cdot A^3$ (the greedy Hungarian approach, Figure~\ref{fig3}A).`
- [ ] **L397** · Must fix · mismatch (B17) · **#20: attributes the largest improvement to eviction alone, but that arm also changed two other settings**
  - **Issue:** Every evicting arm also changes sync and distThresh 50 → 25 (`figs/out/fig8_methods_50.json` configs), so the step is not eviction alone.
  - **Fix:** Discloses the confound.
  - **Current:** `The largest single step was from no eviction to $N = 1$, and the differences among the evicting windows were small at the session level ($N = 20$ versus $N = 1$, 10 and 30, two-sided Wilcoxon signed-rank test, $P = 0.24$, 0.94 and 0.29).`
  - **Replace with:** `The largest single step was from no eviction to $N = 1$, which also turns on synchronous scoring and the tighter distance threshold, and the differences among the evicting windows were small at the session level ($N = 20$ versus $N = 1$, 10 and 30, two-sided Wilcoxon signed-rank test, $P = 0.24$, 0.94 and 0.29).`
- [ ] **L203** · Must fix · scope (B4) · **#21: "about 30 times faster" holds only at 2 animals × 5 cameras**
  - **Issue:** 29× holds only at 2×5. The others are 40×, ~4,400× and ~8,800×, and 4×6 is intractable (`figs/data/fig3/fig3e_head_to_head.csv`). Do not write "at least 30": 2×5 is 29.2×.
  - **Fix:** Scopes the number.
  - **Current:** `On the frames where exhaustive enumeration can be run, which excludes frames with a missed or duplicated detection, greedy Hungarian matching with a 3D correspondence term misgroups fewer frames than the exhaustive strategy and runs about 30 times faster.`
  - **Replace with:** `On the frames where exhaustive enumeration can be run, which excludes frames with a missed or duplicated detection, greedy Hungarian matching with a 3D correspondence term misgroups fewer frames than the exhaustive strategy and runs about 30 times faster at two animals in five cameras and far faster in larger configurations.`
- [ ] **L243** · Must fix · number (B11) · **#22: shortest session is 1.15 min, not 2**
  - **Issue:** The shortest SLAP-2M session is 1.15 min (10192022174304, master sheet `duration`).
  - **Fix:** 2 → 1.
  - **Current:** `In general, the experiments consisted of placing mice into an enclosure for 2 to 60 minutes and observing behavior.`
  - **Replace with:** `In general, the experiments consisted of placing mice into an enclosure for 1 to 60 minutes and observing behavior.`
- [ ] **L148** · Must fix · typo (reverted) (B29) · **#23: stray backtick prints as a visible quote mark (reverted by an earlier paste)**
  - **Issue:** The stray backtick prints as an opening quote. The fix was reverted by the 03:10 paste.
  - **Fix:** Removes it.
  - **Current:** ``` The exhaustive rule is over the $\sim$22 million camera frames without missing instances.` ```
  - **Replace with:** `The exhaustive rule is over the $\sim$22 million camera frames without missing instances.`
- [ ] **L148** · Must fix · wording (reverted) (B29b) · **#24: reverted wording fix in the IDF1 definition**
  - **Issue:** "counts weighting" reads as if the counts are weighted. The fix was reverted by the 03:10 paste.
  - **Fix:** Adds ", which weights".
  - **Current:** `It is computed as the number of detections matched to the right individual divided by the average of the ground-truth and predicted detection counts weighting false positives and false negatives equally.`
  - **Replace with:** `It is computed as the number of detections matched to the right individual divided by the average of the ground-truth and predicted detection counts, which weights false positives and false negatives equally.`

### 2B. Descriptions that do not quite match the figure or code (should fix) (0 / 16)

A careful reviewer might notice these; none changes a result.

- [ ] **L302** · Must fix · mismatch (B34)
  - **Issue:** Fig 2E bottom drops the worst-fitting view per keypoint by reprojection error (`figs/out/fig4_robust_sessions.json` claim), not a camera.
  - **Fix:** Describes the operation.
  - **Current:** `Figure~\ref{fig2}E scores the same solve before and after dropping the camera with the least reliable detections and shows an overall decrease in reprojection error.`
  - **Replace with:** `Figure~\ref{fig2}E scores the same solve before and after dropping, for each keypoint, the worst-fitting view, and shows an overall decrease in reprojection error.`
- [ ] **L131** · Must fix · mismatch (B12)
  - **Issue:** 4.32 → 3.34 is the DLT curve. The refined curve beside it is 4.42 → 3.15 (`figs/data/fig2/fig2e_accuracy_vs_cameras.csv` dlt_p50 / ba_p50).
  - **Fix:** Names the solver.
  - **Current:** `Scored relative to a camera the solve never saw, error falls from 4.32 pixels with two cameras to 3.34 pixels with four cameras (Figure~\ref{fig2}E) (top).`
  - **Replace with:** `Scored relative to a camera the solve never saw, error in the DLT solve falls from 4.32 pixels with two cameras to 3.34 pixels with four cameras (Figure~\ref{fig2}E) (top).`
- [ ] **L249** · Must fix · mismatch (B6)
  - **Issue:** HardFight is also Fig 3D (its caption), and only Fig 1C and D (1A shows the other two rigs).
  - **Fix:** Lists the panels that use it.
  - **Current:** `The third recording, HardFight, is a single eight-camera, three-mouse session at 60 frames per second, from which a 300-frame window was taken for Figure~\ref{fig1} and Figure~\ref{fig2}A.`
  - **Replace with:** `The third recording, HardFight, is a single eight-camera, three-mouse session at 60 frames per second, from which a 300-frame window was taken for Figure~\ref{fig1}C and D, Figure~\ref{fig2}A and Figure~\ref{fig3}D.`
- [ ] **L118** · Must fix · mismatch (B14)
  - **Issue:** The bracket deliberately spans all 7 stages, including SLEAP's 2D detector, which L112 says LUC3D does not include (`figs/panels/fig1_01_pipeline.py` docstring).
  - **Fix:** Matches the bracket's intended meaning.
  - **Current:** `The bracket marks the stages contributed by this paper.`
  - **Replace with:** `The bracket marks the pipeline this paper presents end to end.`
- [ ] **L118** · Must fix · mismatch (B15)
  - **Issue:** The middle tile of Fig 1D is a Blender render of the app's reconstruction (`fig1d_pose.png`), not a capture of the 3D viewport.
  - **Fix:** Names what is shown.
  - **Current:** `Middle, the 3D viewport.`
  - **Replace with:** `Middle, a render of the reconstructed 3D poses.`
- [ ] **L180** · Must fix · mismatch (B25)
  - **Issue:** Female session medians are negative in 29 of 37 sessions (median −0.07, Wilcoxon vs 0 P = 0.004), so they are small but not zero. The Results (L169) already say "close to zero ($-0.07$)".
  - **Fix:** Matches the Results wording.
  - **Current:** `The male is approaching and the female is neither approaching nor retreating.`
  - **Replace with:** `The male is approaching and the female's score is close to zero.`
- [ ] **L180** · Must fix · mismatch (B26)
  - **Issue:** Near and far are different onsets (2,915 near, 6,439 far).
  - **Fix:** Drops "the same".
  - **Current:** `\textbf{G}, Rear-onset coupling, both directions: the probability the other animal is rearing at each lag around a rear onset, over that animal's own chance rate, for onsets with the pair within 2 body lengths; yellow, the same onsets further apart; gray, a circular-shift null.`
  - **Replace with:** `\textbf{G}, Rear-onset coupling, both directions: the probability the other animal is rearing at each lag around a rear onset, over that animal's own chance rate, for onsets with the pair within 2 body lengths; yellow, onsets with the pair further apart; gray, a circular-shift null.`
- [ ] **L180** · Must fix · mismatch (B27)
  - **Issue:** F's shares keep the 4 tied displays in the denominator (the 0.83 above).
  - **Fix:** Limits the exclusion to C.
  - **Current:** `Four displays in which both bouts begin on the same frame have no initiator and are excluded from C and F.`
  - **Replace with:** `Four displays in which both bouts begin on the same frame have no initiator and are excluded from C.`
- [ ] **L340** · Must fix · incomplete (B38)
  - **Issue:** `--tracking_clean_instance_count` was also set (`figs/fig6_sleap_max2_retrack.py` CAP_FLAGS). Same as the v4 checklist "L342 Imprecise" entry.
  - **Fix:** Adds the flag.
  - **Current:** `sleap-nn (0.3.0) was run with the track count capped at the number of animals in the session, two for Mouse-Dyad-10M, using \texttt{--max\_tracks 2 --candidates\_method local\_queues}.`
  - **Replace with:** `sleap-nn (0.3.0) was run with the track count capped at the number of animals in the session, two for Mouse-Dyad-10M, using \texttt{--max\_tracks 2 --candidates\_method local\_queues --tracking\_clean\_instance\_count 2}.`
- [ ] **L406** · Must fix · broken pointer (B21)
  - **Issue:** That section gives neither the synthetic-rig parameters nor the held-out count (900 appears only in the Supp Fig 3 caption).
  - **Fix:** Points to where each actually is. For the synthetic-rig parameters see data item D5.
  - **Current:** `The settings changed, the synthetic-rig parameters and the held-out frame counts are given in Supplementary Section~\ref{subsec-calib}.`
  - **Replace with:** `The settings changed are given in Supplementary Section~\ref{subsec-calib} and the held-out frame count in Supplementary Figure~\ref{fig8}.`
- [ ] **L443** · Must fix · mismatch (B20)
  - **Issue:** Camera center is a residual divided by the median true camera-pair distance (`figs/fig7_calib_gt_compare.py` L123), not a percentage of its own value.
  - **Fix:** States the denominator.
  - **Current:** `\textbf{I}, Focal length, camera center and rig scale recovered from a synthetic rig with an exactly planar board and known cameras, each as a percentage of its known value.`
  - **Replace with:** `\textbf{I}, Focal length, camera center and rig scale recovered from a synthetic rig with an exactly planar board and known cameras, each as a percentage of its known value (camera center, of the median camera spacing).`
- [ ] **L443** · Must fix · mismatch (B41)
  - **Issue:** The "…and no rejection" row changes two (Anipose's intrinsics plus no rejection; `figs/data/fig7/fig7g_mechanism.csv`).
  - **Fix:** one → one or two.
  - **Current:** `\textbf{G}, calibrat3's solver re-run on identical detections with one setting changed, on the 18-camera rig.`
  - **Replace with:** `\textbf{G}, calibrat3's solver re-run on identical detections with one or two settings changed, on the 18-camera rig.`
- [ ] **L272** · Must fix · mismatch (B44)
  - **Issue:** Fig 3E is scored only on frames where exhaustive enumeration can run (no missed or duplicated detection). *(ledger evidence)*
  - **Fix:** Scopes Fig 3E.
  - **Current:** `Behavioral analyses and tracking metrics (Figures~\ref{fig3} and~\ref{fig4} and Supplementary Figure~\ref{fig6}) were computed on every frame of each session.`
  - **Replace with:** `Behavioral analyses and tracking metrics (Figures~\ref{fig3} and~\ref{fig4} and Supplementary Figure~\ref{fig6}) were computed on every frame of each session, with Figure~\ref{fig3}E on the eligible frames.`
- [ ] **L262** · Must fix · mismatch (B48)
  - **Issue:** The figures use floor-aligned frames (SLAP-2M `aligned_points3d.h5`; Mouse-Dyad-10M metres ×1000), not the calibration frame (`figs/DATA-LOCATIONS.md` "Frames of reference").
  - **Fix:** Drops the incorrect frame.
  - **Current:** `All 3D coordinates are expressed in the calibration's own metric frame in millimeters.`
  - **Replace with:** `All 3D coordinates are expressed in millimeters.`
- [ ] **L451** · Must fix · unexplained (B40)
  - **Issue:** Every preview pane in panel A reads "30 fps", while acquisition is 100 fps (panel D: 9.997 ms median interval).
  - **Fix:** Explains the pane labels.
  - **Current:** `1920 $\times$ 1200 and 100\,fps, hardware-triggered by an Arduino Mega 2560.`
  - **Replace with:** `1920 $\times$ 1200 and 100\,fps, hardware-triggered by an Arduino Mega 2560 (preview panes in A display at 30 fps).`

- [ ] **L326** · Must fix · overclaim (B37)
  - **Issue:** The slot-swap control compares a fixed set of paired fields, not every feature (`figs/fig4_slot_swap_control.py`).
  - **Fix:** Adds "compared".
  - **Current:** `The output was the same set of displays with the roles reversed and every per-animal feature identical to the last digit.`
  - **Replace with:** `The output was the same set of displays with the roles reversed and every compared per-animal feature identical to the last digit.`

### 2C. Polish (optional) (0 / 10)

Precision wording, rounding and typos. Nobody would call these wrong.

- [ ] **L131** · Must fix · mismatch (B12b)
  - **Issue:** 2 of 10 camera pairs fall outside the ±25% band, including the 13° example the next sentence cites (12.6 mm measured, 6.5 mm predicted; `figs/data/fig2/fig2d_baseline_angle.csv` `within_band`).
  - **Fix:** Adds "roughly".
  - **Current:** `Error falls as $k$ over the sine of the angle between the two cameras relative to the animal (dashed curve).`
  - **Replace with:** `Error falls roughly as $k$ over the sine of the angle between the two cameras relative to the animal (dashed curve).`
- [ ] **L274** · Must fix · overclaim (B43)
  - **Issue:** True for the median step (0.23–0.59 mm); 26–40% of frame steps exceed 1 mm. *(ledger evidence)*
  - **Fix:** Adds "typically".
  - **Current:** `At 150 fps an animal moves less than a millimeter between consecutive frames, so sampling every 15th frame (0.1 s intervals) reduces redundant information and increases computational tractability.`
  - **Replace with:** `At 150 fps an animal typically moves less than a millimeter between consecutive frames, so sampling every 15th frame (0.1 s intervals) reduces redundant information and increases computational tractability.`
- [ ] **L167** · Must fix · mismatch (B46)
  - **Issue:** The curves in Fig 4G are across-session medians, not averages.
  - **Fix:** Names the statistic.
  - **Current:** `Averaging the likelihood of rearing relative to the onset of the other animal's rearing demonstrates an asymmetric leader and follower relationship (Figure~\ref{fig4}G).`
  - **Replace with:** `The median likelihood of rearing relative to the onset of the other animal's rearing demonstrates an asymmetric leader and follower relationship (Figure~\ref{fig4}G).`
- [ ] **L180** · Must fix · wording (B47)
  - **Issue:** Every camera sees some height cue. What only triangulation gives is metric height.
  - **Fix:** Adds "metric".
  - **Current:** `Every camera is mounted between 58 to 76 degrees above the animals, so the height axis exists only after triangulation.`
  - **Replace with:** `Every camera is mounted between 58 to 76 degrees above the animals, so the metric height axis exists only after triangulation.`
- [ ] **L332** · Must fix · wording (B49)
  - **Issue:** 1/C is a ceiling. The measured values are 0.146 and 0.157 against 1/C = 0.20. L150 already says "cannot exceed about $1/C$".
  - **Fix:** puts → caps.
  - **Current:** `A tracker whose ids are kept separate per camera can match the truth in at most one camera, which puts it near $1/C$.`
  - **Replace with:** `A tracker whose ids are kept separate per camera can match the truth in at most one camera, which caps it near $1/C$.`
- [ ] **L404** · Must fix · rounding (B19)
  - **Issue:** The 18-camera median is 378.5 (9th/10th of 18 values = 375/382, `figs/out/fig7_calibration.json` datasets.calib18.timing.calibrat3_800.detectionPerView).
  - **Fix:** Rounds to 379.
  - **Current:** `That is a median of 2,606 frames per camera on the 2022-10-07 SLAP-2M session and 623 on the 18-camera session, where calibrat3's sampled subset gives 882 and 378, so Anipose fits from more frames in both.`
  - **Replace with:** `That is a median of 2,606 frames per camera on the 2022-10-07 SLAP-2M session and 623 on the 18-camera session, where calibrat3's sampled subset gives 882 and 379, so Anipose fits from more frames in both.`
- [ ] **L186** · Must fix · typo (B28)
  - **Issue:** Malformed double parenthetical.
  - **Fix:** One parenthetical.
  - **Current:** `Meanwhile, the mean error of the detections that are present rises only 1.30-fold, from 3.65 to 4.74~pixels (See Figure~\ref{fig5}E) (middle).`
  - **Replace with:** `Meanwhile, the mean error of the detections that are present rises only 1.30-fold, from 3.65 to 4.74~pixels (Figure~\ref{fig5}E, middle).`
- [ ] **L312** · Must fix · typo (B35)
  - **Issue:** Typo.
  - **Fix:** Removes "by".
  - **Current:** `Missing keypoints are by reported by difficulty rating and recovery is examined by adding more cameras to the triangulation.`
  - **Replace with:** `Missing keypoints are reported by difficulty rating and recovery is examined by adding more cameras to the triangulation.`
- [ ] **L258** · Must fix · typo (B36)
  - **Issue:** "output" is doubled and garbles the sentence.
  - **Fix:** One "output".
  - **Current:** `Additionally, Panopticon contains an on-board interface for optogenetic stimulation paradigms, using the same trigger board as acquisition for exact correspondence between output capture signals and output stimulation.`
  - **Replace with:** `Additionally, Panopticon contains an on-board interface for optogenetic stimulation paradigms, using the same trigger board as acquisition for exact correspondence between capture signals and stimulation output.`
- [ ] **L443** · Must fix · grammar (B42)
  - **Issue:** Ungrammatical.
  - **Fix:** Drops "that", adds a comma.
  - **Current:** `(A to G are scored on Anipose's own detected corners so the comparison that does not favor calibrat3.)`
  - **Replace with:** `(A to G are scored on Anipose's own detected corners, so the comparison does not favor calibrat3.)`

## 3. Should fix: overclaims (your call) (0 / 24)

- [ ] **L99** · Should fix · overclaim (C6)
  - **Issue:** Labelling time is never measured, only placements (75 → 32, Fig 2B).
  - **Fix:** States what was measured.
  - **Current:** `Reprojections let users label a subset of views and correct the rest, which speeds up multi-view labeling considerably.`
  - **Replace with:** `Reprojections let users label a subset of views and correct the rest, which reduces the manual placements needed for multi-view labeling.`
- [ ] **L101** · Should fix · overclaim (C7)
  - **Issue:** At 5 cameras, 2.5 of 45 reprojected placements still need correcting at 10 px (Fig 2B).
  - **Fix:** Drops "accurate".
  - **Current:** `Reprojection-aided labeling lets a frame labeled in a few anchor views generate accurate labels in all remaining views, sharply reducing the number of manual labels needed to generate a consistent training set.`
  - **Replace with:** `Reprojection-aided labeling lets a frame labeled in a few anchor views generate labels in all remaining views, sharply reducing the number of manual labels needed to generate a consistent training set.`
- [ ] **L101** · Should fix · unmeasured (C8)
  - **Issue:** No proofreading-effort measurement exists. States it as design.
  - **Fix:** Rephrases as a design property.
  - **Current:** `The LUC3D cross-view tracker resolves identity across all cameras at once, so proofreading a session requires reviewing it once rather than once per camera.`
  - **Replace with:** `The LUC3D cross-view tracker resolves identity across all cameras at once, so a session can be proofread in one pass rather than once per camera.`
- [ ] **L112** · Should fix · unclear (B18)
  - **Issue:** "it" has no antecedent. In Fig 1E, Label3D has 3D proofreading and JARVIS only reprojection-error review (`figs/data/fig1/fig1e_tool_table.csv`).
  - **Fix:** Names each capability.
  - **Current:** `Figure~\ref{fig1}E compared LUC3D to existing packages designed to address similar issues, notably Label3D and JARVIS both provide it \citep{Hueser2023, Aldarondo2019}.`
  - **Replace with:** `Figure~\ref{fig1}E compared LUC3D to existing packages designed to address similar issues, notably Label3D, which provides 3D proofreading, and JARVIS, which provides reprojection-error review \citep{Hueser2023, Aldarondo2019}.`
- [ ] **L112** · Should fix · overclaim (C5)
  - **Issue:** The tracker only leaves it unassigned; duplicate status was established afterwards (median 2.9 px from a matched track).
  - **Fix:** States what the tracker does.
  - **Current:** `Importantly, LUC3D identifies that the remaining detection is a duplicate of an already-matched animal in a view the panel does not show, which one-to-one assignment correctly refuses.`
  - **Replace with:** `Importantly, LUC3D leaves the remaining detection unassigned, and it is a duplicate of an already-matched animal in a view the panel does not show, which one-to-one assignment correctly refuses.`
- [ ] **L125** · Should fix · unmeasured (C15)
  - **Issue:** Placement precision is not measured (Fig 2B covers effort only).
  - **Fix:** Deletes the clause.
  - **Current:** `Therefore, when using reprojection-aided labeling, adding additional cameras to an experimental preparation can drastically save the user time when labeling frames, while increasing the precision of each keypoint's placement.`
  - **Replace with:** `Therefore, when using reprojection-aided labeling, adding additional cameras to an experimental preparation can drastically save the user time when labeling frames.`
- [ ] **L184** · Should fix · overclaim (C16)
  - **Issue:** No deposit measures the accuracy of recovered keypoints. What is measured is that detected-keypoint error rises only 1.30-fold (L186).
  - **Fix:** Retitles to what is measured.
  - **Current:** `\subsection{Multi-view recovers missing points without sacrificing overall pose quality}\label{subsec2-6}`
  - **Replace with:** `\subsection{Multi-view recovers missing points while keeping detection error low}\label{subsec2-6}`
- [ ] **L186** · Should fix · wording (C10)
  - **Issue:** The medians are not monotonic (0.989, 0.917, 0.969, 0.675, 0.877, 0.654 for ratings 2–7).
  - **Fix:** Adds "generally".
  - **Current:** `Figure~\ref{fig5}B characterizes how the LUC3D tracker's IDF1 score degrades with increased difficulty levels ranging from highly accurate ID tracking with two animals and no enrichment objects (median IDF1 = .989) to multiple animals and multiple enrichment objects (median IDF1 = .654).`
  - **Replace with:** `Figure~\ref{fig5}B characterizes how the LUC3D tracker's IDF1 score generally degrades with increased difficulty levels ranging from highly accurate ID tracking with two animals and no enrichment objects (median IDF1 = .989) to multiple animals and multiple enrichment objects (median IDF1 = .654).`
- [ ] **L186** · Should fix · unsupported cause (C4)
  - **Issue:** Transparency is recorded nowhere, and the cause was not measured.
  - **Fix:** Softens to "consistent with".
  - **Current:** `At the same difficulty rating, sessions with more animals miss more keypoints (at rating 4, 11.9\%, 19.0\% and 39.5\% with one, two and four animals; Figure~\ref{fig5}D), because the animals occlude one another while most enrichment objects are transparent.`
  - **Replace with:** `At the same difficulty rating, sessions with more animals miss more keypoints (at rating 4, 11.9\%, 19.0\% and 39.5\% with one, two and four animals; Figure~\ref{fig5}D), consistent with the animals occluding one another.`
- [ ] **L199** · Should fix · unmeasured (C17)
  - **Issue:** No timing of labelling or proofreading exists.
  - **Fix:** States the measured effect.
  - **Current:** `This tool can speed up the labeling and proofreading process by facilitating reprojection-aided labeling and cross-view identity tracking which would otherwise require significant manual labor.`
  - **Replace with:** `This tool can reduce the manual work of labeling and proofreading by facilitating reprojection-aided labeling and cross-view identity tracking which would otherwise require significant manual labor.`
- [ ] **L203** · Should fix · overclaim (C11)
  - **Issue:** r = 0 (632 per 100k) is on the ~45M full-session frames and exhaustive (81 per 100k) on the ~22M clean frames. The only frame-matched comparison is the default (8.0 vs 81, `figs/out/fig3_frame_matched_bmimica.json`).
  - **Fix:** shows → suggests.
  - **Current:** `The ablation shows that the 3D term is what makes the greedy search competitive, since without it the greedy search falls behind exhaustive enumeration.`
  - **Replace with:** `The ablation suggests that the 3D term is what makes the greedy search competitive, since without it the greedy search falls behind exhaustive enumeration.`
- [ ] **L203** · Should fix · unmeasured (C14)
  - **Issue:** Real-time is not measured; timings are from Node, and the app runs Track Frame and batch Track All.
  - **Fix:** Drops "real-time".
  - **Current:** `This enables real-time interactive cross-view tracking that can be used in a browser-based GUI environment.`
  - **Replace with:** `This enables interactive cross-view tracking that can be used in a browser-based GUI environment.`
- [ ] **L205** · Should fix · wrong comparator (C1)
  - **Issue:** Fig 2B compares against labelling every view of the rig by hand (75 → 32). A single view needs 15 labels per frame, fewer than 32.
  - **Fix:** Correct comparator.
  - **Current:** `Reprojection-aided labeling allows the generation of training sets from scratch using far fewer manual labels than a traditional single-view set up.`
  - **Replace with:** `Reprojection-aided labeling allows the generation of training sets from scratch using fewer manual labels than labeling every view by hand.`
- [ ] **L207** · Should fix · overclaim (C12)
  - **Issue:** The output still contains errors (IDF1 0.861; hardest SLAP-2M stratum median 0.654).
  - **Fix:** Drops "proofread".
  - **Current:** `The LUC3D cross-view tracker instead produces an automated proofread output for both cross-view identity assignment and temporal identity tracking.`
  - **Replace with:** `The LUC3D cross-view tracker instead produces an automated output for both cross-view identity assignment and temporal identity tracking.`
- [ ] **L207** · Should fix · unmeasured (C2)
  - **Issue:** Proofreading time was never measured.
  - **Fix:** States it as expectation.
  - **Current:** `Without LUC3D it scales linearly with the number of cameras (a two-camera rig doubles the proofreading time and a four-camera rig quadruples it).`
  - **Replace with:** `Without LUC3D it is expected to scale linearly with the number of cameras (a two-camera rig doubles the proofreading time and a four-camera rig quadruples it).`
- [ ] **L209** · Should fix · overclaim (B5)
  - **Issue:** All 17 pairings with displays have a female majority, but the weakest is 3 of 5 (60%) (`figs/data/fig4/fig4f_leader_by_session.csv` by pair).
  - **Fix:** large majority → majority.
  - **Current:** `The female consistently leads the display, starting the large majority of them across nearly every session and every pairing.`
  - **Replace with:** `The female consistently leads the display, starting the majority of them across nearly every session and every pairing.`
- [ ] **L209** · Should fix · untested (C3)
  - **Issue:** No 2D or single-view comparison was run.
  - **Fix:** States what was done.
  - **Current:** `It also revealed an asymmetry between the two animals of each pair, the female leading and the male following, that would not be visible without cross-view identity and metric distance.`
  - **Replace with:** `It also revealed an asymmetry between the two animals of each pair, the female leading and the male following, that is measured here with cross-view identity and metric distance.`
- [ ] **L209** · Should fix · untested (C3b)
  - **Issue:** Same: "necessary" was not tested.
  - **Fix:** necessary → used.
  - **Current:** `The result establishes a stable directional social dynamic in this cohort, and multi-camera 3D pose estimation was necessary to characterize it.`
  - **Replace with:** `The result establishes a stable directional social dynamic in this cohort, and multi-camera 3D pose estimation was used to characterize it.`
- [ ] **L211** · Should fix · overclaim (C13)
  - **Issue:** The 2D detector (SLEAP) must still be installed (L112, L270).
  - **Fix:** Scopes the claim.
  - **Current:** `By reducing manual labor and eliminating installation requirements, LUC3D makes 3D multi-animal pose estimation accessible to labs without dedicated engineering support.`
  - **Replace with:** `By reducing manual labor and eliminating installation requirements after 2D detection, LUC3D makes 3D multi-animal pose estimation accessible to labs without dedicated engineering support.`
- [ ] **L219** · Should fix · overclaim (C19)
  - **Issue:** The lazy loader keeps the column store resident (≈1.8 GB on the real project, CLAUDE.md luc3d #193); only frames are lazy. *(ledger evidence)*
  - **Fix:** States what is lazy.
  - **Current:** `SLEAP predictions are read lazily, so prediction files larger than the browser's available memory can still be opened.`
  - **Replace with:** `SLEAP predictions are read lazily, so large prediction files can be opened without loading every frame into memory.`
- [ ] **L320** · Should fix · overclaim (results hold) (C18)
  - **Issue:** The score is cos(facing, direction to partner) × unsigned speed, so it cannot tell toward from away (`figs/fig4_upright.py` L199–201). **The approach claim itself holds:** separation closes before onset in 30 of 37 sessions (Wilcoxon P = 0.003), and the male is faster in 28 of 37. So L169 and L209 can stay.
  - **Fix:** Defines the score as computed.
  - **Current:** `A negative score means the animal is oriented toward its partner and approaching it, and a positive score means it is oriented away and retreating.`
  - **Replace with:** `A negative score means the animal is moving while oriented toward its partner, and a positive score means it is moving while oriented away.`
- [ ] **L389** · Should fix · your call (B22)
  - **Issue:** The numbers are correct, but it is a mean: SLEAP is ahead in 39, 9 are tied and the median is about 0, and the text does not say P excludes ties (with ties counted as losses it would be 0.014).
  - **Fix:** Optional disclosure. You asked for minimal, so skip if you prefer.
  - **Current:** `Pooled over all 74 sessions LUC3D's within-view IDF1 is higher by 0.026 (26 of 74 sessions, sign test $P = 0.14$).`
  - **Replace with:** `Pooled over all 74 sessions LUC3D's within-view IDF1 is higher by 0.026 (26 of 74 sessions, 9 tied, sign test excluding ties $P = 0.14$).`
- [ ] **L395** · Should fix · overclaim (C9)
  - **Issue:** Every evicting arm in F also changes sync and distThresh, so F cannot isolate eviction.
  - **Fix:** identifies → is consistent with.
  - **Current:** `Identity switches are the tracker's main remaining association error, and the parameter sweep in Supplementary Figure~\ref{fig6}F identifies their main cause.`
  - **Replace with:** `Identity switches are the tracker's main remaining association error, and the parameter sweep in Supplementary Figure~\ref{fig6}F is consistent with their main cause.`
- [ ] **L404** · Should fix · overclaim (minor) (C20)
  - **Issue:** aniposelib 0.8.0 `detect_video(skip=20)` samples every 20th frame until the board appears (library source).
  - **Fix:** Adds "nearly".
  - **Current:** `Its detector covers every frame in which a camera sees the board.`
  - **Replace with:** `Its detector covers nearly every frame in which a camera sees the board.`

---

## 4. Figure fixes (no sentence to paste; re-render, re-assemble, re-upload)

- [x] **Fig 2E bottom** · ⚠ Must fix (D1) · **done 2026-09-29: recoloured to salmon (DLT) in `panels/fig2_06_solver_accuracy.py`, Fig 2 re-assembled; caption edit is L136 (B54)**
  - **Issue:** Plots only the DLT solve (all views vs the worst view dropped), drawn in TEAL, the colour the top axis uses for "refined". Refined is not plotted. The bars are a t-based 95% CI of the mean; the caption's CI sentence describes a median CI.
  - **Fix:** Colour it SALMON (DLT), or add the refined series. Caption the bottom as "(DLT; mean and t-based 95\% CI)". Code: `figs/panels/fig2_06_solver_accuracy.py` L76.
- [x] **Fig 2G** · ⚠ Must fix (D2) · **done 2026-09-29: resolved by the re-timed bars (y axis now ends at 150)**
  - **Issue:** The top y tick label "300" is clipped by the panel edge.
  - **Fix:** Raise the top margin or drop the 300 tick, then re-assemble Fig 2.
- [x] **Fig 2G caption** · Should fix (D3) · **done 2026-09-29: whisker removed (the re-timed bars are best-of-5 points)**
  - **Issue:** The Anipose-optim whisker (203.6–228.8 µs, across session sizes) is not described.
  - **Fix:** Say what the whisker is.
- [ ] **Fig 3F caption** · Should fix (D7)
  - **Issue:** The error bar on the 4×6 open marker (up to 75,587 s, slowest to fastest measured rate × (A!)^C) is not described.
  - **Fix:** "bar, slowest to fastest measured rate".
- [ ] **Supp Fig 1F legend** · ⚠ Must fix (D4)
  - **Issue:** "stale 0" is the no-eviction control (no sync, distThresh 50). N = 0 would mean evicting everything. The panel script's own docstring says to label it "no eviction".
  - **Fix:** Relabel "no eviction" in `figs/panels/fig6_07_pr_switches.py` L114, then run `fig6_sync.py` and `assemble.py 6`.
- [ ] **Supp Fig 1 caption E** · Should fix (D8, ledger evidence)
  - **Issue:** "on one real frame": the anchor gaps are drawn schematically and the scene uses two frames.
  - **Fix:** "schematic on a real frame".
- [ ] **Datasheet** · ⚠ Must fix (D5)
  - **Issue:** SLAP-2M "Total Animals" prints a literal "?" (`figs/dataset_sheets.py` L97).
  - **Fix:** Fill in the count, or delete the row.
- [ ] **Fig 1D label** · Should fix (D6)
  - **Issue:** "Hard Fight rig", but "HardFight" everywhere else.
  - **Fix:** "HardFight".

## 5. Code and deposit fixes (reproducibility)

- [x] **`figs/out/fig6_slap2m_fair.json`** now also stores `sign_p_ties_excluded` (0.136 / 0.164 / 0.0156), the P values the text quotes (E1). Done 2026-09-29.
- [x] **Shipped tracker ≡ benchmarked configuration:** 50/50 sessions byte-identical (E5, `figs/out/verify_shipped_tracker.json`). Done 2026-09-29.
- [ ] **`figs/fig4_controls.py`** `MIN_DISPLAYS = 5` → `6` (E2). The text reports ≥6 (23 sessions), which matches `fig4_replication.py`.
- [ ] **Pair-level sign test and female-share Wilcoxon** (L324, 14/14, P = 1.2e-4 and 9.7e-4) are computed by no script. Add them to `fig4_replication.py` output (E6).
- [ ] **`figs/out/fig3_quality.json`** (un-suffixed) does not match the paper; only the suffixed default-arm file does. Rename or delete it (E7, ledger evidence).
- [ ] **`figs/DATA-LOCATIONS.md`** says SLAP-2M is "30.0 fps on every session" and "18.1 h". 13 sessions are 60 fps, and the total is about 17.4 h (E3).
- [ ] **`panels/fig3_06_head_to_head.py`** `FPS = 50.0` in an unplaced footnote → 30 (E4).

## 6. Data or answers needed before release

- [x] **D1 (F1) · Calibration controls on 4.13** (L406, L414): **DONE 2026-09-29.** Both tools on OpenCV 4.13 (asserted); rebuilt from the raw 18-camera HEVC (`/root/vast/eric/calibration_test/2024-12-06_19-12-39calibration`) via `figs/fig7_calib18_transcode.sh` and `figs/fig7_calib_controls_413.sh`. Work folder `/root/vast/eric/calib-bench-413/`. Result: the L414 text holds unchanged. The re-run's absolute defaults (Anipose 1.252, calibrat3 0.188 px on 652,540 observations) differ from the figure's (1.280 / 0.212 on 645,451) because the lost H.264 transcode could not be reproduced byte for byte. Compare arms within `fig7s3_equal_frames.csv` only.
- [ ] **D2 (F2, B39) · Panopticon deposit** (L265, L422, Supp Fig 4): 1.15 vs 0.48 px, 32,532 corner observations, 1.3% focal agreement, 9.997 ms / 2.3 µs timing, 210–223 ppm and "up to 13 ppm, 15 ms" (panel E reads ≈12 ppm, ≈14 ms), 542–2,118×, nine-camera Basler rig. **None of these has a data file anywhere in the repo.** Deposit the measurement outputs, or say where they live.
- [ ] **D3 (F3) · Calibration frame counts** (L404 "867 to 1,003"; L443 "9,029"): no per-session list is deposited.
- [ ] **D4 (F4, C21) · HardFight proofreading** (L243 "All three recordings have been manually proofread in 3D"): every HardFight file on disk has only predicted instances, and SLAP-2M was proofread in 2D ("Manual + Automated"). **Your answer:** where is the proofread HardFight? Then describe each dataset accurately.
- [ ] **D5 (F8) · Synthetic rig parameters** (L406, L416): off-centre principal point (median 19.7 px), fy/fx +3.5%, k2 0.05, which aniposelib's model cannot represent. Undisclosed (`figs/out/fig7_calibration.json` `synthetic.raw`).
- [ ] **D6 (F6) · Ethics** (L253): only Princeton IACUC is cited. **Your answer:** the approval body for each dataset (SLAP-2M, HardFight).
- [ ] **D7 (F7) · Unreported control** (L406): the "calibrat3's detections passed to aniposelib's solver" control exists only in the old run and its result is reported nowhere. Report it or remove the sentence.

## 7. Release steps

- [ ] **R1** · Upload repo `figs/figures/fig6/fig6.pdf` (the rebuilt Supplementary Figure 1) to the LaTeX build as `figs/fig6.pdf`. Build `figs/fig8.pdf` = repo `figs/figures/fig7/fig7.pdf`.
- [ ] **R2** · Re-upload Fig 2 and Supp Fig 1 after the section 4 fixes.
- [ ] **R3** · Deploy `main` to the live site (it still shows "BA"; the paper describes `main`'s "Refined (Ref)").
- [ ] **R4** · Code availability: L365 is still `% TODO: add code availability statement`.
- [ ] **R5** · Licenses: a ledger reported the luc3d and calibrat3 GitHub repos have no license file (not confirmed; check on GitHub).
- [ ] **R6** · Commit the drivers, deposits, rebuilt figure and `.tex`.

## 8. Author decisions (no fix proposed until you decide)

- [ ] **L99 vs L263** (G1): L99 "LUC3D also includes … a browser-based camera calibration tool" vs L263 "This paper presents … calibrat3". The LUCID app itself does not calibrate. Decide whether LUC3D names the app or the suite, and say it once.
- [ ] **L148** (G2): the exhaustive reference's identities are threaded by nearest-3D-centroid matching (our scaffolding). Consider disclosing it.
- [ ] **L201** (G3): "fast enough for interactive use in the browser" rests on Node timings.
- [ ] **L395** · "Identity switches are the tracker's main remaining association error": false positives are about 10× switches in Supp Fig 1D (ledger evidence). Consider "a main remaining association error".

## On record, not for the text (your instruction)

- **Held-out-camera triangulation error** (J1): Anipose 3.107, LUC3D refined 3.147 (worse in 49/50), DLT 3.336 px. In-solve, refined is lowest (2.152). "Little difference" stands.

## Checked and rejected (no change)

- **L304 "The temporal smoothing term in the non-linear path was disabled." (B32): now true as written.** The re-timed Fig 2G Anipose-optim bar uses scale_smooth = 0, the same variant as the accuracy comparison. No edit.

- **L136 six 2025-09-08 sessions on the preceding day's calibration (B45 = F5): author decision 2026-09-29, not disclosed in the caption (too much detail).** On record: those six sessions have empty `calibration/` folders and use the rig from 2025-09-07.

- **L118 "the 5 calibrated cameras and enclosure with tracked 3D poses" (A2): author decision 2026-09-29, keep "enclosure".** The audit flagged it from a note in `figs/DATA-LOCATIONS.md` ("Fig 1a's box is a movement footprint and must never be captioned as an enclosure"). The author says the caption is correct. **Update that note** so future audits do not flag it again.

- **L387 "the same SLEAP and ByteTrack settings":** same flags; version and cap are disclosed at L340.
- **L142 "(Figure~\ref{fig3}B)" at the sentence end (B13):** a citation at sentence end does not claim the panel shows both counts.
- **Supp Fig 1 caption:** needs no change after the rebuild.
