# Handoff: eric-mimic2-0-6 (Fig 3), 2026-10-20

**STATUS: DONE 2026-10-20 ~03:50 UTC.** Tasks 1-4 finished, see the plan log entry of that time. Task 5: eric-mimicc can now run X6/X7.
For the final build (X7), Fig 3 must be built with `FIG3F_CLEAN=1`. For a `c6b3` variant, symlink `fig3_runtime_clean_c6b3.json`, `fig3_headtohead_clean_c6b3.json` and `fig3_runtime_clean_a4c6_c6b3.json` to their `_b3` files (the `_b3` link for a4c6 already exists).
Timing caveat (in Methods): the greedy time includes per-process JIT warm-up, so LUC3D's cost is overstated up to ~2x at the 100-frame cells. That is conservative for the claim.

**Estimate was about 2 hours. Actual: about 40 min.** The 4x6 greedy sitting took 90 s (greedy only, 900 frames in all), the fig3c rebuild about 1 min, and the tex numbers were already checked in `P1-M4-PROPOSED-EDITS-2026-10-19.md`. Not done: compiling the tex. The assembled `fig3c.png` was inspected. Open question, not changed: panel E is drawn as bars with a whisker, but the caption describes box plots with a median (unchanged since the 10-19 fig3c build).

## Ground rules

- Eric's decision (2026-10-20): keep fig2c, fig3c and fig6c, and change the tex to match. No new analyses, except the one small timing gap in task 2.
- The plan is `figs/figures/drafts/CONSISTENCY-PLAN-2026-10-19.md` ("Split, 2026-10-20"). Log every step there.
- Only edit Fig 3 text: L148, L150, the Fig 3 caption and include (~L156-160) and L285-289. eric-mimicc edits everything else. Grep-verify after every edit.
- Any timing run needs nothing else of ours running on this host (check with `pgrep`). Record `/proc/loadavg`.

## Tasks

1. **Wire 3F to the clean deposits.** fig3c F was built 20:27 on 10-19 from `out/fig3_runtime_b3.json` (one session, first 3,000 frames, exhaustive timed at 16 jobs). The clean data are in `out/fig3_runtime_clean_b3.json` and `out/fig3_headtohead_clean_b3.json`.
   - `panels/fig3_06_head_to_head.py` reads `fig3_headtohead.json` + `fig3_runtime.json` `measured`. The clean `measured` rows have no `session` or `status`, so `luc3d_for()` needs a clean path. Take the greedy time from `seconds_per_frame` and the exhaustive time from `seconds_per_frame_exhaustive`, keyed by (animals, cameras, dataset).
   - Make the panel's `FPS` constant agree with the tex. The tex says one second of "30 fps SLAP-2M" video, and the panel uses 50.
   - The current fig3c, from before the change, is the reference. Only F may change.
2. **Fill the 4x6 greedy gap.** The clean sitting timed no greedy run at 4 animals x 6 cameras, which is the open-marker column. Add a greedy-only cell to `figs/fig3f_timing_clean.py`: the 3 four-animal SLAP-2M sessions, 6 cameras, tail-free, the same K and seed rules, 3 rounds. Write it to a NEW file (`out/fig3_runtime_clean_b3_a4c6.json`). Do not overwrite the T1 deposits.
3. **Rebuild fig3c** the way it was built before (`FIG_VARIANT=b3 FIG_TAG=c`, see `out/md56_logs/FIG3C_*`). Check 3F by eye.
4. **Tex, Fig 3 only.** Clean values (median of 3 rounds, identical frames):

   | cell | greedy | exhaustive | ratio |
   |---|---|---|---|
   | 2x5 Mouse-Dyad | 0.238 ms | 4.00 ms | 16.8x |
   | 2x6 SLAP-2M | 0.276 ms | 5.45 ms | 19.7x |
   | 3x5 SLAP-2M | 0.500 ms | 887 ms | 1,774x |
   | 4x3 SLAP-2M | 0.473 ms | 1,539 ms | 3,250x |

   - **L148**: "20 times" -> about 17 times at two animals in five cameras. 3.1 / 0.16 ms -> 4.0 / 0.24 ms. Take the 4x6 greedy value from task 2. Recheck ">5 hours". The fastest clean rate per hypothesis is 85 µs (2x6), and 7,962,624 distinct hypotheses x 85 µs x 30 frames is about 5.6 h, so it still holds.
   - **L150**: Figs 3G and H. Use section 1 of `P1-M4-PROPOSED-EDITS-2026-10-19.md`, checked against `out/fig3_sweep50__distanceThreshold25-stale20_f7733dbf_b3_framematched.json`.
   - **L285-289**: "3.1 to 5.4 ms" -> 4.0 to 5.5 ms, and 0.88 / 1.5 s stays. "Like LUC3D, it leaves out the four tail nodes" is wrong for Mouse-Dyad b3, where both arms keep the tail in. Fix it, and also the "24 million" camera frames: it is 48.7 of 50.4 million on b3.
   - **Fig 3 caption**: "Tail keypoints were left out of the tracking ... throughout" holds for SLAP-2M only. Recheck "~5.2 million frames" and the 98-session counts against the b3 headtohead.
   - **L156**: `figs/fig3.pdf` -> `figs/fig3c.pdf` (M1).
   - Add a timing provenance sentence to the Fig 3F Methods: identical frames, one process at a time, alternating, 3 rounds, solve time only, plus the host load.
5. Tell eric-mimicc that Fig 3 is done, so it can run X6/X7.

## Done means

- fig3c F plots only clean-sitting values, and the 4x6 point comes from the new deposit.
- Every Fig 3 number in the tex matches a field in a named deposit.
- Plan rows T1, M1 and P2 are ticked.
