# D: Supp Fig 6 / Supp 2-7, 2-9, s-DANNCE, Methods baseline + anchor (complete)

Placed figure: figs/figures/fig6/fig6.pdf (Oct 19 20:56). Layout (assemble.py LAYOUTS[6]): a=fig6a_block (2x2 A-D), e=chen_style, f=fig6f_switch_reduction (Oct 19 14:31, panels/fig6slapstale_reduction.py, reads out/stale_sweep_slap2m.json), g=fig6g_sdannce_survival.
A reads out/fig7_variant_best_c6b3.json (+ fig7_fair_baselines_c6b3.json -> c6b3nd symlink); B-D read its `slap2m_fair` block.

## Claims table

| tex line | claim | source | value found | verdict | note |
|---|---|---|---|---|---|
| 409 | median within-view IDF1 LUC3D 0.995 | variant_best_c6b3 slap2m_fair.within_view.luc3d.median | 0.99531 | OK | |
| 409 | SLEAP 0.992 | ...sleap.median | 0.99259 | ROUNDING/WRONG | rounds to 0.993 (truncated) |
| 409 | ByteTrack 0.987 | ...bytetrack.median | 0.98796 | WRONG | rounds to 0.988 (truncated) |
| 409 | 1-animal median diff 0.000, mean -0.0003 | paired_vs_sleap["1"] | 0.0 / -0.000334 | OK | |
| 409 | SLEAP higher in 14 single-animal sessions to LUC3D's 1 | paired_vs_sleap["1"].per_session | 14 neg, 1 pos, 17 tie | OK | deposit's own `losses: 31` counts ties as losses (misleading field, text is right) |
| 409 | all 74: 32 / 24 / 18 tied, sign P=0.35 | recomputed binomtest | 32/24/18, P=0.3497 | OK | |
| 409 | >=2 animals 31 of 42, SLEAP 10, 1 tie, P=0.0015 | recomputed | 31/10/1, P=0.00145 | OK | |
| 409 | median diff 0.076 at two animals | paired_vs_sleap["2"].median | 0.07585 | OK | |
| 409 | 3-4 animals: 6 of 7, P=0.13 | recomputed | 6/1, P=0.125 | OK | |
| 409 | median 0.11 (3 animals), 0.15 (4) | paired_vs_sleap 3/4 median | 0.1063 / 0.1504 | OK | |
| 409 | missed detections 80-84% of errors | error_decomposition fn_share | 0.804/0.839/0.822 | OK | |
| 409 | FP 0.52% / 0.57% / 0.72% | FP/11,726,640 | 0.517/0.568/0.717 | OK | |
| 409 | ID switches 0.028% vs 0.056% and 0.051% | id_switches/11,726,640 | 0.0284/0.0555/0.0514 | OK | LUC3D 3333 = stale20 cell of stale sweep |
| 411 | LUC3D 0.968 within, 0.968 across | data/fig6/fig6a_within_vs_cross_variant.csv | 0.96759 / 0.96757 | OK | = fig8_methods_50_b3 sync_stale20_dist25 |
| 411 | SLEAP 0.830 -> 0.186 | same csv | 0.8298 / 0.1864 | OK | |
| 411 | ByteTrack 0.825 -> 0.191 | same csv | 0.8251 / 0.1905 | OK | |
| 411 | retain about 23% | ratio col | 22.5% / 23.1% | OK (approx) | SLEAP 22.5% |
| 415 | N=20 switches 3,753 -> 3,333, 11% fewer | out/stale_sweep_slap2m.json | 3753 / 3333, 11.2% | OK | |
| 415 | mean cross IDF1 (42 multi) 0.911 -> 0.932 | per_session cross_idf1, animals>1 | 0.9110 / 0.9317 | OK | |
| 415 | 20 improved, 6 worsened, Wilcoxon P=0.012 | recomputed | 20/6/16 tie, P=0.0124 | OK | |
| 417 | 3,500 / 3,406 / 3,333 / 3,390 | stale_sweep_slap2m.json | same | OK | |
| 417 | 7, 9, 11, 10% fewer | recomputed | 6.7/9.3/11.2/9.7 | OK | |
| 417 | IDF1 0.894, 0.918, 0.932, 0.929 | recomputed (42 multi) | 0.8935/0.9182/0.9317/0.9287 | OK | |
| 417 | N=20 vs N=1 P=0.003; vs 10, 30 P=0.72, 0.49 | recomputed Wilcoxon (42 multi) | 0.0032 / 0.715 / 0.485 | OK | |
| 417 | MD: no eviction 110 vs 144 at N=20 | out/fig8_methods_50_b3.json | 110 / 144 | OK | |
| 417 | MD 12 better w/o, 4 worse, P=0.017 | recomputed per_session cross_idf1 | 12/4, P=0.0174 | OK but METRIC UNSTATED | this is cross-view IDF1; on per-session switches it is 2 better vs 6 worse, P=0.16. Text sits in a switches sentence. |
| 421 | median 1.0 in all three datasets | data/fig6/fig6g_sdannce_survival.csv | TRIADS 5/6, BEDDING 5/6, SCN2A 25/29 at 1.0 | OK | |
| 421 | 35 of 41 exactly 1.0 | same | 5+5+25 = 35 | OK | |
| 421 | 5/6, 5/6, 26/29 no switch (abstract "88%") | fig6i_sdannce_contact.csv switches_sigma0; placed PDF text "36/41" | 5/5/26, 36/41 = 87.8% | OK | |
| 421 | four swaps within 6 mm, fifth at 45 mm | fig6i swap_dist_mm / results_v105/agg/swapdiag | 2.96, 0.70, 5.87, 0.29; 45.08 | OK | |
| 421 | one swap reverted after one frame, four lasted | swapdiag soc1 2022_09_23_M3_M2 frames 11039->11040 | yes | OK | |
| 421 | 0.970 and 0.972 within first ~3% | swapdiag bedding F6_F2 f2723/90000, soc3 M3_M4 f2454/89000 | 3.0%, 2.8% | OK | |
| 421 | 0.792 TRIADS at 41,298 of 60,000; 0.648 SCN2A at 31,312 of 89,000 | swapdiag | same | OK | |
| 421 | 36 no-swap sessions hold 68,560 frames < 50 mm | fig6i frames_lt50mm | 68,560 | OK | |
| 421 | randomized GT 0.500, splice 0.5, wrong calibration 0.519 | results_v105/agg/controls.json | 0.500083 / 0.5 / 0.519458 | OK (v105) | pre-v105 results/agg/controls.json has 0.512858; text uses v105 |
| 425 | TRIADS 6 x 3 rats x 60,000; BEDDING 6 x 2 x 90,000; SCN2A 29 x 2 x 89,000; 14 + 15 | fig6i csv; v105 summary.csv (soc1 14, soc3 15) | same | OK | 50 fps / 23 nodes not checked |
| 487 cap | 6G 41 sessions, six cameras, no noise | cell C1_sigma0 | 41 | OK | |
| 337 | SLEAP sleap-nn 0.3.0 MD, 0.2.0 SLAP; cap = n animals | fair_baselines_c6b3nd config; fig6_slap2m_fair.py | yes | OK | |
| 337 | ByteTrack 60-frame retire -> 0.4 s MD | 150 fps | 0.4 s | OK | SLAP "1 to 2 s" not verified (fps not in deposits) |
| 339 | ByteTrack IDF1 > 1 in 10 of 444 SLAP camera-sessions, max 1.0049 | out/fig6_slap2m_fair_sleapnt_percam.csv | 10, 1.00488 | OK | no dedupe, consistent with rule |
| 345 | N swept 1, 10, 20, 30 vs none; 74 SLAP, 56 MD | stale_sweep_slap2m.json; fig8_methods_50_b3.json | yes | OK | |
| 345 | distance limit 50 -> 25 mm; stale 20 default; sync | lucid-main-md56 @2dc001fe ui/settings.js:342 (distanceThreshold 25), :332 (corr3dWeight 6), pose/cross-view-tracker.js:311 (stale 20), sync unconditional | match | OK | CrossViewTracker class fallback is 1.0/1.0; app default comes from settings.js |
| 347 | selected configuration is current default | same | stale 20, dist 25, r 6 | OK | |
| abstract ~103 | MD mean cross-view IDF1 0.968; switches < 1 per 100k | fig8_methods_50_b3 sync_stale20_dist25 | 0.96757; 0.286 per 100k | OK | |
| abstract ~103 | SLAP multi-animal mean cross-view IDF1 0.932 | stale_sweep_slap2m.json stale20, 42 multi | 0.9317 | OK | |
| ~150 (Fig 3G text) | default r = 6 | settings.js corr3dWeight default 6 | 6 | OK | |

## Provenance checks

- Placed figures/fig6/fig6.pdf = copy of fig6c, built by out/md56_logs/M3_make_figures.log (2026-10-19 20:56, variant c6b3). Panel F built 10-19 14:31 from out/stale_sweep_slap2m.json (lucid-main-md56 @2dc001fe, bvis5 pool, r 6, tail-free scoring). The text in the placed PDF ("7% 9% 11% 10%", "TRIADS 5/6 ... all 36/41", ".52% .028% .57% .06% .72% .051%") matches the tex.
- A: fig7_variant_best_c6b3.json was rewritten 10-20 04:11, after the figure was built. The note says metadata only, data blocks asserted unchanged, and data/fig6/fig6a_within_vs_cross_variant.csv still matches it.
- B-D: `slap2m_fair` was copied from fig7_variant_best_md56.json (10-14). Its percam source out/fig6_slap2m_fair_sleapnt_percam.csv is dated 10-15. LUC3D ID switches (3,333) equal the v1.0.5 stale-20 sweep cell exactly. But the median within-view IDF1 differs in the 5th decimal (0.99531 vs 0.99527 in the sweep). That fits a different scorer (luc3d-bench eval_camera vs fig3 score), not a different run. It looks like v1.0.5, but the deposit does not record the LUC3D tracker dir or commit directly.
- G (s-DANNCE): M3 ran with no FIG6_SDANNCE_AGG, so the placed 6G was built from the pre-v1.0.5 fig10-bench/results/agg. For the C1_sigma0 cell, idf1 and switches are identical in all 41 sessions between results/agg and results_v105/agg. panel_10f_merge.json and all 5 swapdiag files are byte-identical. So the placed 6G is numerically the same as v105. The only v105 difference touching the tex is the wrong-calibration control (0.519 in v105, 0.513 in the old run), and the tex uses v105. Cosmetic fix: rebuild 6G with FIG6_SDANNCE_AGG=results_v105/agg so the build provenance is v1.0.5. The v105 swapdiag files have the same bytes and seeds as the old run, so they may have been copied rather than regenerated. The 6 mm / 45 mm / frame claims depend on them.
- SLAP tracking tail-free: pool lite_bvis5 keeps tail coordinates (build_lite_pools.py only counts body nodes for the filter). The tail is removed at tracking time by fig3_bench.mjs excludeTail (default true, weight 0). That script itself notes target creation ignores nodeWeights unless --tail-nan, and stale_ab/stale_sweep do not pass --tail-nan. So "tail-free tracking" holds for matching weights but not for target birth. Worth a check by whoever owns the Fig 3/4 pool rules.

## Problems, most important first

1. **Two medians at tex line 409 are truncated, not rounded.** SLEAP is 0.99259, which rounds to **0.993** (tex 0.992). ByteTrack is 0.98796, which rounds to **0.988** (tex 0.987). Source: out/fig7_variant_best_c6b3.json slap2m_fair.within_view.*.median. LUC3D 0.995 is correct.
2. **Line 417, Mouse-Dyad staleness comparison: the metric is not named.** "12 sessions better without it and 4 worse, P = 0.017" is per-session **cross-view IDF1** (stale 0 vs stale 20, out/fig8_methods_50_b3.json). The sentence is about switches. Per-session switches give 2 better vs 6 worse, Wilcoxon P = 0.16, not significant. Suggest saying "cross-view IDF1 favored no eviction in 12 sessions and eviction in 4". Note also that MD mean cross IDF1 is 0.986 at stale 0 vs 0.968 at the stale-20 default the paper reports.
3. **Placed 6G build provenance is pre-v1.0.5** (results/agg, not results_v105/agg). The numbers are identical, so nothing printed changes. Rebuild with FIG6_SDANNCE_AGG for clean provenance.
4. **Leftover / misleading data files in data/fig6/**: fig6f_pr_switches.csv (MD sweep, not the placed SLAP panel F), fig6f_sdannce_survival.csv (old letter), and fig6a_within_vs_cross.csv (50-session fig3_trackers series with LUC3D 0.749, not placed). **Placed panel F has no CSV in data/fig6** (it reads out/stale_sweep_slap2m.json directly). Some deposit fields are also misleading: `paired_vs_sleap["1"].losses = 31` counts 17 ties as losses (the tex's 14 vs 1 is right), and fair_baselines' `claim` text says "50 sessions" but n = 56.
5. Minor: "about 23%" covers 22.5% (SLEAP) and 23.1% (ByteTrack). Acceptable. "1 to 2 s for SLAP-2M" (60-frame ByteTrack buffer) is not verified, since the SLAP fps is not in the deposits I read.
6. Tail-free SLAP tracking is only via node weights. Target birth sees the tail (no --tail-nan). This is a rule-compliance question, not a number error.

Everything else checked (all staleness numbers and P values, SLAP sign tests, error-decomposition percentages, Fig 6A values, every s-DANNCE claim, Methods defaults vs v1.0.5 code, abstract repeats) is OK.
