# Proposed tex edits on b3 (NOT applied), 2026-10-19

The claims in these paragraphs change on the b3 data, so they need Eric's call rather than an
unattended number swap. Each item gives the current text, the b3 values with their source files,
what breaks, and a lightly edited suggestion in the manuscript's style. Numbers checked on
eric-mimicc-0-1 on 2026-10-19.

Already applied to `luc3d_newest.tex` (pure number swaps, claim unchanged):
- L103 abstract: Mouse-Dyad mean cross-view IDF1 0.873 -> **0.968** (`fig8_methods_50_b3.json`, sync_stale20_dist25 = Fig 6c a LUC3D row).
- L411: LUC3D 0.872 / 0.873 -> **0.968 / 0.968**. SLEAP 0.661 -> 0.148 becomes **0.830 -> 0.186**, ByteTrack 0.755 -> 0.177 becomes **0.825 -> 0.191** (`data/fig6c/fig6a_within_vs_cross_variant.csv`). "About 23%" still holds (0.225, 0.231).

## 1. L150, Fig 3G/H (the 3D-term sweep)

Fig 3c G/H now plot the FRAME-MATCHED sweep, every point scored on the 48,693,535 camera-frames
exhaustive enumeration computed (`out/fig3_sweep50__distanceThreshold25-stale20_f7733dbf_b3_framematched.json`,
rule from `out/fig3_frame_matched_bmimica_b3.json`).

| | switches /100k | cross IDF1 |
|---|---|---|
| exhaustive (rule) | 4.19 | 0.847 |
| r = 0 | 17.1 | 0.748 |
| r = 0.001 | 9.3 | 0.773 |
| r = 0.01 | 3.66 | 0.824 |
| r = 0.02 | 1.88 | 0.860 |
| r = 1, 2 | 0.226 (110 sw) | 0.977 |
| r = 4 to 16 (default 6) | 0.267 (130 sw) | 0.969 |
| r = 24 | 0.267 | 0.976 |

Full-session values, for reference (`..._b3.json`, 50,423,670 camera-frames): r = 0 22.8 /100k and 0.748, r = 6 0.286 and 0.968.

What breaks in the current text:
- 90 /100k and 0.657 (exhaustive), 528 and 0.612 (r = 0), 0.73 and 0.873 (r = 6) are all old-pool numbers.
- "Every non-zero ratio ... does better than exhaustive" is false: r = 0.001 has 9.3 switches against 4.19, and r = 0.01 has a lower IDF1 (0.824 vs 0.847). Both measures beat exhaustive from r = 0.02 upward.
- "Doubling the ratio to 12 lowers this to 0.67" is false: r = 6 and r = 12 are identical (130 switches, 0.969). Note r = 1 and 2 are slightly better than the default (110 switches, 0.977).
- "about 24 million of the 50 million camera frames" is now 48.7 of 50.4 million on b3, and the separate "scored on those same frames" sentence is redundant because the whole panel is now frame-matched. Greedy at r = 6 has 16x fewer switches than exhaustive (4.19 / 0.267), not 68x.

Suggested (from "Exhaustive enumeration has no 3D correspondence term" to the end of the paragraph):
> Exhaustive enumeration can only run on frames that have no missing detections, 48.7 million of the 50.4 million camera frames, and every setting in Figures~\ref{fig3}G and H is scored on exactly those frames. Exhaustive enumeration has no 3D correspondence term and switched identity 4.2 times per 100,000 camera frames at a cross-view IDF1 of 0.847. With the 3D term removed ($r = 0$), the greedy Hungarian association does worse than exhaustive enumeration, with 17.1 switches per 100,000 camera frames and an IDF1 of 0.748. From $r = 0.02$ upward, greedy association does better than exhaustive enumeration on both measures, so the 3D term is what enables the greedy matching to outperform it. The app default, $r = 6$, gives 0.27 switches per 100,000 camera frames at an IDF1 of 0.969, 16 times fewer switches than exhaustive enumeration. Every ratio from 4 to 16 gives the same result, so the default sits on the plateau.

## 2. L293, camera subsets (M4)

Source `out/fig2_cams_identity_b3.json` (three fixed subsets per k, 56 sessions; k = 5 is the full run, gate passed).

| k | within IDF1 (mean of the 3 subsets; per subset) | switches over 56 sessions |
|---|---|---|
| 2 | 0.922 (0.931, 0.909, 0.926) | 166 to 254 |
| 3 | 0.960 (0.954, 0.975, 0.952) | 96 to 316 |
| 4 | 0.973 (0.971, 0.973, 0.973) | 92 to 132 |
| 5 | 0.968 | 144 |

What breaks: 0.69 / 0.78 / 0.83 / 0.87 and 2,572-3,707 -> 367 are old-pool numbers, and neither
"rises with every camera added" nor "switches fall the same way" holds (k = 4 beats k = 5 on both;
k = 3 spans 96 to 316). The sentence starting "Because" also breaks the style rule.

Suggested (replace from "Within-view IDF1 rises" to the end of the paragraph):
> Identity tracking holds up with fewer cameras. Mean within-view IDF1 is 0.92 with two cameras, 0.96 with three, 0.97 with four and 0.97 with all five. Over the 56 sessions, the three two-camera subsets give 166 to 254 identity switches, the four-camera subsets 92 to 132, and the full rig 144. Fewer cameras means fewer camera frames, so switches are compared as rates per camera frame.

(Check `fig2_cams_identity_b3.json` `gate.reference` too: it still names `fig8_methods_50.json`, see X6.)

## 3. L413-417, "Stale evidence in the 3D anchor is the dominant switch mechanism"

This is the biggest one. On b3 Mouse-Dyad, **no eviction is the best setting**, so the subsection's
thesis does not hold on Mouse-Dyad. Source `out/fig8_methods_50_b3.json` + `_b3stale.json`, 56 sessions,
50,423,670 camera-frames; Wilcoxon two-sided on per-session cross IDF1 vs N = 20.

| N | switches | mean cross IDF1 | median | N = 20 better / worse in sessions, P |
|---|---|---|---|---|
| none (stale 0) | 110 | 0.986 | 0.998 | 4 / 12, P = 0.017 |
| 1 | 168 | 0.966 | 0.997 | 9 / 10, P = 0.69 |
| 10 | 158 | 0.962 | 0.997 | 7 / 4, P = 0.13 |
| 20 (default) | 144 | 0.968 | 0.998 | |
| 30 | 112 | 0.981 | 0.998 | 4 / 7, P = 0.05 |
| 40 | 122 | 0.978 | 0.998 | 7 / 8, P = 0.31 |
| 50 | 128 | 0.978 | 0.998 | 4 / 10, P = 0.056 |

On SLAP-2M (74 sessions, `out/stale_sweep_slap2m.json`, now Fig 6c f) eviction does help:
3,753 switches at stale 0, 3,500 / 3,406 / 3,333 / 3,390 at 1 / 10 / 20 / 30 (7, 9, 11, 10% fewer).
The caption of Supp Fig 6 F was updated to describe this SLAP-2M panel (P3), but L415-417 still
cite Supplementary Figure 6F for the Mouse-Dyad numbers (1,789 -> 367 etc.).

Decision needed: either re-ground the subsection on SLAP-2M (where the effect exists and the figure
now is), or keep Mouse-Dyad and rewrite the claim (on b3 the default N = 20 is not the best setting).
No suggested text, because the direction is Eric's call.

## 4. Not checked here

- L103 "triangulates up to 16,030 frames per second": the source of this number was not found in
  `figs/out/*.json`, and Fig 2G's DLT time changed (1.19 -> 0.95 us per keypoint). Recompute from
  fig2c before submission.
- L103 "up to 14,694 frames per second" and every Fig 3F number: wait for T1 (main box).
