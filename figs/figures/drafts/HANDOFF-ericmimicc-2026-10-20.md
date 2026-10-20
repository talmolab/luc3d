# Handoff: eric-mimicc-0-1, 2026-10-20

**Estimate: about 2.5 to 3.5 hours of work** (tex edits 1 to 1.5 h, final build and gates 1.5 to 2 h). The optional Fig 7H rerun (item 6) adds about 2.5 h of machine time if Eric wants it. The other host (eric-mimic2-0-6) does Fig 3 in parallel, in about 2 h.

## Ground rules

- Eric's decision (2026-10-20): **keep fig2c, fig3c and fig6c as the figures, and change the tex to match them.** No new analyses.
- The plan is `figs/figures/drafts/CONSISTENCY-PLAN-2026-10-19.md`. Read its rules and its "Split, 2026-10-20" section first. Log every step there.
- Both hosts share /root/vast and edit `luc3d_newest.tex` at the same time, and Eric edits it too. **Do not touch Fig 3 text**: L148, L150, the Fig 3 caption (~L156-160) and L285-289 belong to eric-mimic2. Grep-verify after every edit. Line numbers drift, so find each paragraph by its text.
- Back up the tex before the first edit (`figs/out/md56_logs/luc3d_newest.before_mimicc_2026-10-20.tex`).
- Style: short plain sentences, no semicolons or colons in the prose.

## Tasks

1. **Staleness subsection, L413-417** ("Stale evidence in the 3D anchor is the dominant switch mechanism").
   Default unless Eric says otherwise: re-ground it on SLAP-2M, which is what fig6c F shows.
   - SLAP-2M, 74 sessions, `out/stale_sweep_slap2m.json`: 3,753 switches at stale 0, then 3,500 / 3,406 / 3,333 / 3,390 at N = 1 / 10 / 20 / 30 (7, 9, 11 and 10% fewer). Pull IDF1 and any session-level test from the same deposit. Do not quote anything that is not in it.
   - Remove the Mouse-Dyad numbers (1,789 -> 367, 0.773 -> 0.873 and so on). They are from the old pool.
   - Add one honest sentence on Mouse-Dyad b3: there, no eviction gives 110 switches against 144 at N = 20 (P = 0.017, `out/fig8_methods_50_b3.json` + `_b3stale.json`).
   - The title claims "dominant". Soften it if SLAP-2M's 11% does not support that word.
   - Show Eric the new text before saving if the title changes.
2. **Camera subsets, L293 (M4).** Paste section 2 of `P1-M4-PROPOSED-EDITS-2026-10-19.md`. Check it against `out/fig2_cams_identity_b3.json` first.
3. **Abstract speeds, L103.** "16,030" and "14,694 frames per second" are **Eric's in-app measurements**: v1.0.5, Chrome, his 16 GB Apple M1 MacBook Pro, timed with a snippet pasted into the web console. They are NOT the Fig 2G or Fig 3F benchmarks. **Keep them. Do not recompute them.** Add one provenance sentence in Methods (FIX-CHECKLIST A1.3): in-app, v1.0.5, Chrome, Apple M1 laptop, and that the benchmarks were run on a different machine and with a different method, so the numbers differ. Ask Eric for the session, Chrome version and the averages he saw. Do not invent them.
4. **Fig 6 include, L484.** `figs/fig6.pdf` -> `figs/fig6c.pdf`. Check that the caption letters still match fig6c (P3 says A-G match).
5. **Number sweep of everything outside Fig 3.** Grep the tex for every Mouse-Dyad and SLAP-2M number and check each one against the fig2c / fig6c data (`figs/data/fig2c`, `figs/data/fig6c`). Already done: L103 IDF1 0.968, L411, the Fig 2G numbers, the S3 sentence and the Fig 6 caption. List anything you cannot source rather than changing it.
6. **Optional, ask Eric first: Fig 7H calibration timing (T3).** Prep is done and the scripts are in `figs/out/md56_logs/calib_b/` (`run_all_b.sh`, stage `sitting`). Run it only if he wants 7H redone, with nothing else of ours running on this host. Otherwise soften L435 ("each tool running alone on an idle 64-core machine"), because that cannot be verified.
7. **Last, after eric-mimic2 reports Fig 3 done:**
   - X6: fix the stale metadata in `fig3_exhaustive_bmimica_b3.json` and `fig8_methods_50_b3.json`. The exact corrections are in the plan's X6 row.
   - X7: final build of Figs 2-7 together. One variant, `FIG_TAG=c`, `FIG_VARIANT_REQUIRE` set. Start from `figs/out/md56_logs/run_FINALBUILD.sh` and `run_C6_build.sh`. Rerun the gates (`figs/m6_frame_gate.py`, `figs/s4_frame_gate.py`). Diff the rebuilt `figs/data/fig{2..6}c` CSVs against the current ones. Any change has to be explained.

## Done means

- Every task above is ticked in the plan with its source file.
- No Mouse-Dyad number in the tex comes from the tail-free md56 or old pool.
- A final grep shows that `fig3.pdf` and `fig6.pdf` are no longer included, and that L103 still has 16,030 and 14,694.
