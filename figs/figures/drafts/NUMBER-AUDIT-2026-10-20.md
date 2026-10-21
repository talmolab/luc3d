# Number audit of luc3d_newest.tex, 2026-10-20

**Question (Eric).** Are the numbers in `luc3d_newest.tex` correct? Do they match the analysis behind the figures as they are placed now?

**Answer.** Almost all of them do. About 300 claims were traced to the placed data and recomputed. None of the large numbers is wrong. The problems fall into four groups:

1. **The placed Fig 3 is one build behind the text.** The tex has the J17 timing. The placed PDF has the older T1 timing.
2. **Two medians are cut off instead of rounded.**
3. **A few sentences say more than the data show, or don't name the measure they use.**
4. **Some build records and analysis outputs say the wrong thing**, although the placed numbers are right.

**What was checked.** The tex as of 20:28 UTC, including the uncommitted Fig 3F diff, against the figures at commit `a6752bc0` and the analysis outputs in `figs/out/`. Nothing was edited and nothing heavy was run.

**Detail.** The per-section tables (tex line, claim, source, value, verdict) are in `figs/figures/drafts/number-audit/`:

| File | Covers |
|---|---|
| `A_fig1_fig2.md` | abstract, introduction, Fig 1, Fig 2, Methods Software and Triangulation |
| `B_fig3.md` | Fig 3, association, tracking metrics, statistics |
| `C_fig4_fig5.md` | Fig 4, Fig 5, detection pool, occlusion, behaviour, rearing controls |
| `D_supp6.md` | Supp Fig 6, baselines, anchor staleness, s-DANNCE |
| `E_datasets_calib_discussion.md` | Discussion, GUI, datasets, calibration (Fig 8), Panopticon (Fig 9), datasheet |

In the column "Checked", **yes** means I re-checked the finding myself against the data. **agent** means it rests on the audit agent's work.

## Problems, most important first

### A. A placed figure disagrees with the text

| # | Where | Problem | Evidence | Fix | Checked |
|---|---|---|---|---|---|
| A1 | L148, L200, Fig 3F | The placed `figures/fig3/fig3.pdf` and `data/fig3/fig3e_head_to_head.csv` (03:27) use the T1 timing: 2×5 greedy 0.238 ms vs exhaustive 4.00 ms (16.8×), 4×6 greedy 0.653 ms. The tex uses J17: 0.282 vs 3.95 ms (14.0×), 0.703 ms. The J17 build exists only in the untracked `figures/fig3c/fig3c.pdf` and `data/fig3c/` (16:57). | CSV diff, file times | Promote fig3c to fig3, or rebuild Fig 3 with `FIG3F_CLEAN=1 FIG3F_CLEAN_TAG=_j17`. Panel F prints no numbers, so the figure looks almost the same | yes |
| A2 | Fig 1 caption L118 | The repo's `figures/fig1/fig1.png` (10-02) is lettered a = dataset arenas, b = pipeline, c = cross-view re-ID, d = triangulated 3D, e = capability table. The caption has A = cross-view association, B = pipeline, then 3D and datasets, and never describes panel e. | viewed the PNG; `assemble.py` LAYOUTS[1] | Re-letter the caption, unless the Overleaf `fig1.pdf` is a different file | yes |

### B. Wrong numbers

| # | Where | Text | Correct | Source | Checked |
|---|---|---|---|---|---|
| B1 | L409 | SLEAP median within-view IDF1 0.992 | **0.993** (0.99259) | `out/fig7_variant_best_c6b3.json` `slap2m_fair.within_view.sleap.median` | yes |
| B2 | L409 | ByteTrack 0.987 | **0.988** (0.98796) | same, `.bytetrack.median` | yes |
| B3 | L239 | sessions last "5 to 60 minutes" | The 13 SLAP-2M sessions at 60 fps (2022-10-19) last about 1.2 to 3 min | session videos | agent |
| B4 | L103 | SLAP-2M keypoints seen by two "of the six cameras" | 95.1% is right, but over the 6 analysed cameras. SLAP-2M has 8 everywhere else in the tex | `data/fig4/fig4b_occlusion_sessions.csv` | agent |

### C. The sentence claims more than the data show, or doesn't name its measure

| # | Where | Problem | Checked |
|---|---|---|---|
| C1 | L200 (Discussion) | "Greedy Hungarian matching misgroups fewer frames than the exhaustive hypothesis testing strategy". This is true pooled over all frames (0.022% vs 0.030%), at 2×5 (1,390 vs 1,401) and at 2×6 (728 vs 1,541). It is **false at 3×5 (47 vs 19) and 4×3 (45 vs 22)**, in `data/fig3/fig3c_quality.csv`. Scope it to pooled frames or to two animals | yes |
| C2 | L417 | "12 sessions better without it and 4 worse, P = 0.017" compares per-session **cross-view IDF1**. It follows a switch count, so it reads as switches. By switches it is 2 better and 6 worse, P = 0.16. Name the measure | yes (text); agent (numbers) |
| C3 | L181 | "This sequential relationship is not observed when the animals are further apart." Within ±1.5 s the far-apart curves still move: the male's rises to 1.44× chance and the female's falls to 0.41×. The near-apart curves are much stronger: the female's reaches 5.25×, while the male's ranges from 0.29 to 1.71×. "Much weaker" fits | yes |
| C4 | Fig 5G caption | "9,354 rear onsets from all 56 sessions, 2,915 within two body lengths" are the right counts. The plotted curves are medians over only 32 sessions (male) and 13 (female), because sessions with fewer than 20 onsets are dropped. Methods says this and the caption does not | yes (n_sessions in CSV) |
| C5 | L103 | "100.8 million 2D poses" are reprojections of the 3D (3D poses × views). L241 says so and L103 doesn't. Both datasheet copies also label them plainly as "2D Poses" | agent |
| C6 | L150 / Methods | An identity switch is defined as a detection given the wrong animal's identity. What was counted is the motmetrics ID switch, summed over cameras. IDF1 0.847, 0.748 and 0.969 are **means** over sessions, which isn't stated (the exhaustive median is 0.860) | agent |
| C7 | L275 | "The association relies on the 11 body nodes" (SLAP-2M). Tail nodes get weight 0 in the matching cost but still enter target births and triangulation, because `--tail-nan` was not set. The same applies to the SLAP-2M "tail-free tracking" rule generally | agent (two audits independently) |
| C8 | L303 | "The two fastest steps take about 0.2 s per pass." The DLT pass is 0.18 s, but LUC3D undistortion is 0.33 s. Only those two steps got 100 timed passes. The other 2G bars are medians of 5 rounds, so "median of 100 passes" in the caption does not cover every bar | agent |
| C9 | L301 | "More than 100 times slower" (RANSAC) comes from the earlier J16 sitting (144×), because the J16b step was stopped. L303 says "earlier sitting" for undistortion. L301 should say it too | agent |
| C10 | L285 | The bar on the 4×6 marker is described as spanning two ways of counting hypotheses. The code also prices the two ends at different rates (83.9 vs 111 µs per hypothesis). The lower-bound claim itself holds | agent |
| C11 | L204 | "More cameras, fewer errors" is not monotonic. Five cameras give 0.968 and 144 switches, while the four-camera subsets give 0.971 to 0.973 and 92 to 132 | agent |
| C12 | Methods (timing) | J17 deposits record `sitting.valid=false`: 2 of about 950 samples reached 0.578 core (VS Code server and Claude CLI), above the 0.5 rule. Part 2 is valid on its own (0.268). "No other process of ours" is slightly generous if the Claude CLI counts. Your call | agent |
| C13 | L449 | The equal-frames / reference-camera control was rerun on 2026-09-29 on a re-transcoded video, so it has 652,540 observations, not panel E's 645,451. The numbers are right within that run | agent |
| C14 | Methods L309 | It says 4C uses "the same matching and keypoints" as 4B. They come from two different generators that apply the same matching rule | agent |

### D. Facts in the text that may be wrong (outside the analysis)

| # | Where | Problem | Checked |
|---|---|---|---|
| D1 | L239, L243, datasheet | The listed SLAP-2M strains (CD-1, C57BL/6J, BALB/c) include no agouti strain, yet agouti mice appear in 42 sessions (also in `master_sheet.xlsx`). One strain name is probably wrong | agent |
| D2 | `figures/drafts/figs/datasheet_combined.pdf` | This is the stale Aug 18 copy (Mouse-Dyad sex "Male", proofreaders "?", no Total Animals row). The Oct 1 copy in `figures/datasheets/` is correct. Overleaf may hold either | agent |
| D3 | Fig 9 caption | "All panels … 100 fps", but panel F is a 30 fps calibration | agent |

### E. No data behind the claim

| # | Where | Claim | Checked |
|---|---|---|---|
| E1 | L285 | "Start-up compilation roughly doubles its cost per frame on the 100-frame runs" | agent |
| E2 | L439-441 | 2D model details: SLEAP versions, frame and instance counts, peak thresholds, 3.0 / 1.6 px errors | agent |
| E3 | L457-459, L263, Fig 9 | Panopticon numbers have no data, deposit or generator. They are consistent with each other | agent |
| E4 | L429-435 | The calibration bench can't be reproduced: the script reads a deleted `/tmp/.../calibrat3/.../bench` and records no calibrat3 commit. Every placed number matches its CSV, and the raw inputs are still on disk | agent |
| E5 | L435 | "Each tool run on its own on a 64-core machine": the calibration timing sittings weren't logged | agent |
| — | L103, L236 | In-app speeds 16,030 and 14,694 fps are your M1 measurements, so no deposit exists by design. They agree wherever they repeat | agent |

### F. Build records and analysis outputs that say the wrong thing (placed numbers are right)

| # | Problem | Checked |
|---|---|---|
| F1 | **Rerunning the recorded Fig 4D build would give a wrong Fig 4D.** `run_X7_build` pass 2 loads the Oct 8 `out/fig9_slap2m_lite_bvis5_notailscore.json` (`X7_loads.tsv` L41), which differs by up to 0.18 IDF1 per session. The placed `data/fig4/fig4b_idf1_by_difficulty.csv` matches the correct `_md56` output exactly. The x7 promotion stopped after fig3 (`PROMOTE_fig4.log` is empty) | agent |
| F2 | The Fig 4D output records no LUC3D commit, and its header still says "EXPLORATORY -- not part of the manuscript" | agent |
| F3 | The Fig 4C output (`fig6_detections_proofread_notail.json`) says it used raw detections (`keeptrack_h5s`) but used the proofread 2D labels | agent |
| F4 | The placed Supp 6G was built from the older s-DANNCE run (`fig10-bench/results/agg`, per `M3_make_figures.log`), not `results_v105/agg`. The plotted values are identical (full rig: 36/41 with zero switches in both runs). The tex's 0.519 is the v1.0.5 value. The v1.0.5 swap files are byte-identical to the old run's and may have been copied rather than recomputed. The 6 mm, 45 mm and swap-frame claims rest on them | yes (36/41 in both) |
| F5 | Old comments in outputs and docstrings: "50 BMimica sessions" in the `fig3_quality_b3` / `fig3_headtohead_b3` caveats (the data hold 56), the wrong driver named in the sweep output, "5.3×" in the `fig5_12_coupling.py` docstring, frame 276 in the `fig1_02_tracking.py` docstring, "50 sessions" in the fair-baselines `claim` (n = 56), and `paired_vs_sleap["1"].losses = 31`, which counts ties (the tex's 14 to 1 is right) | agent |
| F6 | Leftover data files that the placed figures don't read: `data/fig6/fig6f_pr_switches.csv` (Mouse-Dyad staleness; the placed 6F reads `out/stale_sweep_slap2m.json`), `fig6f_sdannce_survival.csv`, `fig6a_within_vs_cross.csv` (old 50-session table, 0.749), `fig6h_sdannce_cameras.csv` (unplaced panel H), `data/fig5/fig5g_rear_coupling.csv` (old non-per-direction table), and `data/fig3c/` (holds the J17 CSV, see A1) | yes (6h) |

### G. Minor wording

- L433: "378" is 378.5.
- L445: three of the four SLAP calibration sessions are held out, so calling SLAP the "tuning" rig is loose.
- L453: "agree within 0.002 px" is aniposelib's own reported error, not the scored median.
- L111 and L113: "Supplementary Videos 1 and 2 … in motion" appears twice.
- Discussion "more than half fewer placements" is true for the tau10 curve only.
- Absolute-60 mm control "all 23" uses Fig 5F's 23 sessions. On that detector's own sessions with at least six displays it would be 25 of 26.
- The display distance rule uses the pair's mean body length, which the text doesn't say.

## Not a problem (checked and dismissed)

- **s-DANNCE "36 of 41" vs 37 of 41.** `data/fig6/fig6h_sdannce_cameras.csv` gives 37/41 at 6 cameras. That comes from the unplaced panel H and counts sessions with IDF1 ≥ 0.9999, not sessions with zero switches. In both runs, the full rig (`C1_sigma0`) has exactly 36/41 with zero switches. The 88% in the abstract stands.

## Checked and correct

**Fig 2** (placed build `FIG2C_js2.log`, every input stamped 2dc001fe):
- 75 → 32, 2.3×, 48, 36% fewer
- 4.74 / 1.21 mm
- 12.6 mm at 13°, 2.7 mm at 31°, floor 1.2 mm
- 4.27 → 3.30 px; 56/56 sessions
- 2.15 to 2.34 px; refined lowest in 56/56
- 200,010 keypoints; 0.885 µs; 32× / 4.9× / 11×
- 1.7 and 0.4 µs undistortion; 2.41 px

**Fig 1:** 21 names → 3 identities, 45 keypoints, 7 of 8 cameras.

**Fig 3:**
- 23 and 15 of 98 sessions; 0.022% vs 0.030% misgrouped
- about 10.1M of 10.8M frames; outliers up to 4.1% and 3.1%; 56 + 35 + 4 + 3 sessions
- sweep: 48.7M of 50.4M camera frames; 4.2 and 0.847; 17.1 and 0.748; 0.27 and 0.969; 16× fewer; r = 4 to 16 identical; 20 values of r
- 5.57 h per second of video; 32 and about 190M hypotheses
- tracker defaults in v1.0.5
- camera subsets 0.92 / 0.96 / 0.97 / 0.97 and their switch ranges
- all 196 cached greedy runs re-derive identically at 2dc001fe

**Fig 4 and Fig 5:** about 60 claims, including every Wilcoxon, sign, Mann-Whitney, binomial and Pearson test, the 5G peaks and lags, and the 56 sessions / 4 males / 5 females / 18 pairings. Fig 5A comes from the LUC3D-stamped `fig5_views_js.json`.

**Supp Fig 6:**
- SLAP-2M staleness sweep: 3,753 / 3,500 / 3,406 / 3,333 / 3,390 switches; 7 / 9 / 11 / 10% fewer
- IDF1 0.911 / 0.894 / 0.918 / 0.932 / 0.929; 20 vs 6 sessions, P = 0.012; P = 0.003, 0.72 and 0.49
- SLEAP sign tests 32 / 24 / 18 (P = 0.35) and 31 / 10 / 1 (P = 0.0015); 6 of 7; medians 0.076 / 0.11 / 0.15
- error breakdown; Fig 6A 0.968; Mouse-Dyad 110 vs 144 switches
- every s-DANNCE number (35/41, 36/41 = 88%, 2.96 / 0.70 / 5.87 / 0.29 mm, 45 mm, 68,560 frames, 0.500 / 0.5 / 0.519)
- Methods defaults (stale 20, distance 25, r = 6) against the v1.0.5 code

**Fig 8 (calibration):**
- medians and 95th percentiles 0.07 / 0.09, 0.10 / 0.32, 0.21 / 1.28; all 31 cameras
- ablations 0.212 / 0.868 / 0.252 / 1.235
- synthetic rig 0.05 / 2.20% and 0.03 / 2.98%; 3 of 6 draws diverge
- frame budgets 2,606 / 623 / 882; 9,029 and 12,621 frames re-counted from the videos

**Datasets:**
- Mouse-Dyad: 56 sessions, 10.08M frames per view, 20.17M 3D poses
- SLAP-2M: 74 sessions, 42 multi-animal, 13 at 60 fps, 15.6M frames, 2.81M / 22.5M poses
- 66M frames in total

**GUI claims** match the v1.0.5 code: error colours, export sizes, calibration formats.

**Abstract and Discussion repeats:** 0.968, 0.286 switches per 100k, 0.932, 88%, 0.998 / 0.84, 15% at rating 7, 95%, 32× / 0.89 µs, 0.92 to 0.97, the female leading in 36 of 37 sessions and 17 of 17 pairings. The "0.28 to 0.70 ms" repeat is correct against J17 but not against the placed PDF (A1).

## Suggested order

1. Rebuild or promote Fig 3 (A1) and fix the Fig 1 letters (A2). Those are the two places where the reader sees a figure that disagrees with the text.
2. Make the four number fixes (B1 to B4) and the scope fixes C1 to C4.
3. Decide C7 (tail in SLAP-2M track births), C12 (timing validity) and D1 (strain names).
4. Before the final build, fix the Fig 4D build record (F1), or leave the placed CSV untouched.

## Addendum (21:20 UTC, after the last audit finished)

This report was written at 21:12, three minutes before the datasets / calibration / Discussion audit (`E_datasets_calib_discussion.md`) finished. These items come from its final pass or from my own re-checks.

| # | Where | Finding | Checked |
|---|---|---|---|
| B3 (corrected) | L239 "5 to 60 minutes" | `master_sheet_side_model.tsv` lists **6** SLAP-2M sessions shorter than 5 min. All are from 2022-10-19 and last 1.1 to 2.2 min (4,125 to 7,786 frames at 60 fps). The next shortest is 5.0 min and the longest 60.1 min. "1 to 60 minutes" would be correct. Supersedes B3 above, which said "13 sessions, about 1.2 to 3 min" | yes |
| H1 | L457-459, Fig 9 D/E | The clocks run 210 to 223 ppm slow, which gives a median frame interval of 10 ms × (1 − 216×10⁻⁶) = **9.998 ms**, not the stated 9.997 ms. 9.997 implies about 300 ppm, which is outside the stated range. Either the number was truncated or one of the two values is off. The 15 ms drift does match 13 ppm over 19 min | agent (arithmetic re-checked) |
| H2 | datasheet | "22.49 million" 2D poses is 22,498,600 = 2,812,325 × 8, which rounds to 22.50 M | agent |
| H3 | L226 | The info panel colour-codes only the headline error values, not the per-group error cells as the text implies | agent |
| H4 | L263 vs L461 | L263 says calibrat3 solves the final calibration. L461 says calibrat3 or Anipose | agent |
| H5 | code only | The `fig5_replication.py:7` docstring says "18 pairings" for the 37 sessions with displays. Those sessions cover 17 pairings. All 56 sessions have 18. The tex is right | agent |

## Fixes applied, 2026-10-21 ~01:25 UTC

Backup: `out/md56_logs/luc3d_newest.before_numberfix_2026-10-21.tex`. Eric kept "5 to 60 minutes" (B3), so it was not changed.

- **B1, B2.** L409 now reads 0.993 and 0.988.
- **C2.** L417 now names cross-view IDF1. Re-check: the 12 vs 4 split holds, and an exact Wilcoxon test gives P = 0.016. By switches, no eviction is better in **6** sessions and worse in 2, P = 0.20. That reverses the "2 better, 6 worse" stated in C2 above.
- **C1.** L200 is now scoped to "when pooled over all sessions".
- **C4.** The Fig 5G caption now gives the 32 and 13 sessions.
- **C5, B4.** L103 now says the 2D poses are reprojected from the 3D and names the "six analyzed cameras".
- **C9.** L301 now says the RANSAC ratio was measured in an earlier sitting.
- **A2.** The Fig 1 caption is reordered to match the panels as placed in both `fig1` and `fig1b`: A arenas, B pipeline, C re-ID, D 3D. E (capability table) is new. The text references and the Datasets and Blender Methods sentences follow the new letters, and L113 now cites Fig 1E.
- **Checked against the b series** (`figures/fig{1,2,3,5}b`, `B-SERIES-LUC3D-ONLY-2026-10-20.md`):
  - Its CSVs equal the main ones except Fig 3F, which is the J17 timing the tex already quotes, so every audited number holds for the b figures.
  - Fig 2 and Fig 3 captions match `fig2b` and `fig3b` panel by panel. The Fig 3D caption already describes the b render.
  - Fig 5: "In D and E each point is one session" was wrong, because D to F draw box plots with no points. It now reads "The box plots in D to F summarize one value per session".
