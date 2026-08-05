I have everything. Findings below.

---

# Corpus map (what unit of replication actually exists)

| corpus | n | cams | animals | metrics available |
|---|---|---|---|---|
| SLAP-2M `outputs/metrics/` | **74 sessions** × 6 cams = 444 cam-sessions, 11,726,640 cam-frames | 6 | 1(32) 2(35) 3(**4**) 4(**3**) | **within-view only** + difficulty/bedding/animals |
| SLAP-2M multi-animal `PAF_3d_kalman/_diag/` | **42 sessions** × 6 = 252 cam-tasks, 674,111 frames, 7,438,347 matched animal-frames | 6 | 2(35) 3(4) 4(3) | per-frame ID timelines + per-frame GT inter-animal 3D distance, switch events, error taxonomy |
| BMimica `outputs/bmimica/` | **50 sessions** | 5 | 2 only | **within AND cross-view** IDF1 + switches, 4 trackers |
| hard session `subgroup_7_7_2026/` | **1 session** (10072022145420) | 6 | 4 | within + cross-view, 5 trackers incl. UDMT |

**Provenance hazard, flag before submission.** `outputs/metrics/` is internally inconsistent — three different runs sit in one directory. `per_camera_session_metrics.csv` (May 18 06:55) gives LUC3D IDF1 **0.738301**, switches 8.5045, frags 7.2703; `by_tracker.csv`/`by_animals.csv`/`by_bedding.csv`/`by_camera.csv` (May 18 01:55) give **0.736490**, 8.4459, 7.5225; `auc_summary.tsv` (May 19) gives 0.7383. `PAF_3d_kalman/metrics/headline.csv` shows LUC3D *baseline* = 0.73604 and LUC3D+**PAF L1** = 0.73809 — i.e. the numbers in `outputs/metrics/` labelled "luc3d" are closest to the **PAF-L1 variant, not the shipped baseline**. Fig 7's caption quotes 3-animal 0.373 / 4-animal 0.328 from `by_animals.csv`; the same cells in `per_camera_session_metrics.csv` are **0.376364 / 0.329462**. Pick one file and cite it.

---

## Q1 — `session_wins.csv`: the paired result, and yes, it is the strongest missing result

File is a 3-way argmax over **444 camera-sessions** on **mean IDF1**:

| tracker | wins | pct |
|---|---|---|
| luc3d | **275** | 0.6194 |
| sleap | 157 | 0.3536 |
| bytetrack | 12 | 0.0270 |

`session_pairwise.csv` — head-to-head on IDF1, 444 camera-sessions:

| a | b | a beats b | ties | total |
|---|---|---|---|---|
| luc3d | sleap | **238** | 47 | 444 |
| luc3d | bytetrack | **411** | 7 | 444 |
| sleap | bytetrack | 368 | 7 | 444 |

My recomputation from `per_camera_session_metrics.csv` (the newer run): luc3d 244 / sleap 152 / 48 ties; luc3d 417 / byte 20 / 7; 3-way argmax luc3d 283, sleap 151, byte 10.

**Aggregated to sessions (n=74), which the figures never show:**

| animals | n | LUC3D | SLEAP | paired Δ | LUC3D wins | 95% CI of Δ | Wilcoxon p |
|---|---|---|---|---|---|---|---|
| 1 | 32 | 0.8275 | 0.6862 | **+0.1413** | 25/32 | [+0.1001, +0.1842] | 1.5e-06 |
| 2 | 35 | 0.7332 | 0.6943 | **+0.0388** | 24/35 | [+0.0137, +0.0650] | 0.0032 |
| 3 | **4** | 0.3764 | 0.4030 | −0.0266 | **0/4** | [−0.0682, −0.0054] | 0.125 |
| 4 | **3** | 0.3295 | 0.3571 | −0.0276 | **0/3** | [−0.0498, −0.0066] | 0.25 |
| **all** | **74** | **0.7383** | **0.6614** | **+0.0769** | **49/74** | **[+0.0522, +0.1032]** | **1.33e-06** |

And the strongest single number in the whole benchmark, currently in **no** figure: on the 50 BMimica sessions LUC3D beats SLEAP on **cross-view IDF1 in 50/50 sessions** (and within-view 50/50). Sign test p ≈ 8.9e-16. That is a categorical statement no CI-overlap argument can touch. **Yes — the per-session paired win-rate is the strongest missing result.**

## Q2 — `auc_summary.tsv`: shown in no manuscript figure

| tracker | idf1_auc | idf1_mean | idr_auc | idr_mean | idp_auc | idp_mean | switches_auc_norm | switches_mean |
|---|---|---|---|---|---|---|---|---|
| sleap | 0.6612 | 0.6614 | 0.6308 | 0.6309 | 0.8432 | 0.8434 | 0.8729 | 8.1261 |
| bytetrack | 0.5274 | 0.5274 | 0.4990 | 0.4990 | 0.6936 | 0.6938 | 0.6797 | 27.7140 |
| luc3d | **0.7378** | 0.7383 | **0.7001** | 0.7005 | **0.9447** | 0.9450 | 0.8672 | 8.5045 |

It is a **survival-curve** AUC: "fraction of camera-sessions with metric ≥ τ", τ over [0,1], so AUC ≡ the mean (that identity is why the two columns match to 4 dp). For switches it is "fraction with ≤ K switches", K∈[0,60], normalised. **No figure shows any survival curve** — the bench drew five (`panel_idf1_survival.png`, `idp`, `idr`, `switches_survival`, `panel_track_coverage`) and none made it in. The survival curve is the *shape* result the mean hides. My tail counts (n=74 sessions):

| threshold | LUC3D | SLEAP | ByteTrack |
|---|---|---|---|
| IDF1 < 0.2 | 6 | 7 | 12 |
| < 0.3 | 11 | 13 | 22 |
| < 0.5 | 19 | 23 | 37 |
| < 0.7 | 27 | 34 | 50 |
| < 0.9 | **37** | **52** | 64 |

The separation is largest in the *upper* tail: LUC3D clears 0.9 on 37/74 sessions vs SLEAP's 22/74. That is the honest "shape" claim, and it is stronger than the mean gap.

## Q3 — `by_animals.csv`: FULL table, and the caption is right about the numbers but the n is 4 and 3

Full table verbatim (camera-session-weighted, `by_animals.csv`):

| tracker | A | mota | motp | idf1 | idp | idr | precision | recall | switches | frags | MT | PT | ML |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bytetrack | 1 | 0.785577 | 0.000124 | 0.661583 | 0.793875 | 0.636504 | 0.996047 | 0.789372 | 12.474 | 99.438 | 0.719 | 0.146 | 0.135 |
| bytetrack | 2 | 0.752978 | 0.001602 | 0.443421 | 0.564068 | 0.426217 | 0.983671 | 0.761252 | 45.062 | 163.300 | 1.371 | 0.286 | 0.343 |
| bytetrack | 3 | 0.298174 | 0.004105 | 0.350946 | 0.889929 | 0.249547 | 0.997610 | 0.298958 | 12.792 | 36.625 | 0.333 | 0.708 | 1.958 |
| bytetrack | 4 | 0.263254 | 0.001529 | 0.310867 | 0.882905 | 0.213129 | 0.999149 | 0.263493 | 7.778 | 84.222 | 0.500 | 1.000 | 2.500 |
| **luc3d** | 1 | 0.792167 | 0.000141 | **0.827497** | **0.999979** | 0.792324 | 0.999850 | 0.792275 | **0.000** | 4.698 | 0.719 | 0.151 | 0.130 |
| **luc3d** | 2 | 0.754986 | 0.000852 | **0.729836** | 0.892276 | 0.702200 | 0.982109 | 0.762387 | 15.381 | 5.819 | 1.352 | 0.295 | 0.352 |
| **luc3d** | 3 | 0.294422 | 0.006211 | **0.372799** | 0.938839 | 0.270631 | 0.998494 | 0.295082 | 7.875 | 12.792 | 0.333 | 0.708 | 1.958 |
| **luc3d** | 4 | 0.253570 | 0.003844 | **0.328302** | 0.920211 | 0.228583 | 0.998868 | 0.253989 | 18.389 | 50.500 | 0.500 | 0.944 | 2.556 |
| sleap | 1 | 0.791194 | 0.000143 | 0.686214 | 0.813140 | 0.664237 | 0.995169 | 0.795512 | 6.703 | 0.964 | 0.719 | 0.151 | 0.130 |
| sleap | 2 | 0.765437 | 0.001232 | 0.694308 | 0.846615 | 0.671093 | 0.980631 | 0.773677 | 10.524 | 2.457 | 1.386 | 0.271 | 0.343 |
| sleap | 3 | 0.299423 | 0.005755 | **0.403004** | 0.973892 | 0.295965 | 0.996978 | 0.300095 | 2.167 | 11.042 | 0.333 | 0.708 | 1.958 |
| sleap | 4 | 0.265059 | 0.003914 | **0.357108** | 0.952358 | 0.251904 | 0.998920 | 0.265259 | 3.278 | 48.389 | 0.556 | 0.944 | 2.500 |

**CONFIRMED** — caption's 0.373 vs 0.403 and 0.328 vs 0.357 are exact to `by_animals.csv`. And SLEAP wins in every one of the 4+3 sessions individually (0/4 and 0/3). So the *direction* is robust.

**n per cell — this is the real problem.** 3 animals = **4 sessions** (24 camera-sessions); 4 animals = **3 sessions** (18 camera-sessions). The caption's "over 74 SLAP-2M sessions" is technically true of the corpus but the load-bearing cells are n=4 and n=3. Worse, they are fully confounded: all 3 four-animal sessions are **black bedding** and **difficulty 4**; the four 3-animal sessions are difficulty 3(3) and 7(1); only 1 of 7 is white bedding. Session-level counts:

```
animals 1: black 21, white 11      animals 3: black 3, white 1
animals 2: black 17, white 18      animals 4: black 3, white 0
animals×difficulty: 1→{1:12,2:3,3:6,4:3,5:7,6:1}  2→{2:10,4:7,5:3,6:3,7:12}
                    3→{3:3,7:1}    4→{4:3}
```

**CROSS-view IDF1 per animal count does not exist at n>1.** All 50 BMimica cross-view sessions are **2 mice, 5 cameras**. The only cross-view measurement at >2 animals is the single 4-animal hard session (LUC3D within 0.7087 → cross 0.7069; SLEAP 0.3906 → 0.1034; UDMT 0.5780 → 0.1574; ByteTrack 0.1869 → 0.0443; 3D-MuPPET 0.0685 → 0.0690). So the paper **cannot** currently show that LUC3D wins on cross-view at 3–4 animals with n>1. A referee will find this.

**Defensible honest framing of a scaling panel (n=74):** plot the per-session paired *difference* LUC3D−SLEAP against animal count, with every session as a dot and the count printed on each x tick — `1 (n=32) +0.141 [+0.100,+0.184]`, `2 (n=35) +0.039 [+0.014,+0.065]`, `3 (n=4) −0.027 [−0.068,−0.005]`, `4 (n=3) −0.028 [−0.050,−0.007]`, with the 3/4 tick marks drawn in a de-emphasised style and the annotation "n = 4 and 3 sessions; animal count confounded with bedding and difficulty". A dot plot where the reader can literally count 4 dots is honest; a line chart with a marker at 3 and 4 is not. Then state the actual claim in the same panel: **cross-view 50/50, within-view 49/74**.

## Q4 — `by_camera.csv`: NOT camera-count scaling. There is no camera-count data anywhere.

`by_camera.csv` is per **camera identity** (`back, backL, mid, midL, top, topL`) at C=6 fixed, not per camera count. LUC3D IDF1 by camera, all 74 sessions:

| camera | SLEAP | ByteTrack | LUC3D | Δ vs SLEAP | LUC3D MOTP |
|---|---|---|---|---|---|
| top | 0.710308 | 0.581569 | **0.778895** | +0.0686 | 0.000814 |
| topL | 0.682644 | 0.560918 | **0.752415** | +0.0698 | 0.001029 |
| midL | 0.639118 | 0.488793 | **0.735097** | +0.0960 | 0.000650 |
| mid | 0.673231 | 0.527956 | **0.731481** | +0.0583 | 0.000703 |
| backL | 0.668935 | 0.509661 | **0.725696** | +0.0568 | 0.000868 |
| back | 0.594116 | 0.495437 | **0.695358** | +0.1012 | 0.001688 |

LUC3D wins all 6 cameras; largest gain on the worst view (`back`, +0.101). **It does not support "as cameras increase"** — I grepped the whole bench for `n_cameras|ncam|camera_subset|num_cameras` in every csv/tsv/json/md: **zero hits**. There is no camera-count ablation. The only two C values measured are C=5 (BMimica, n=50, 2 mice) and C=6 (SLAP-2M).

**The 1/C claim does not survive at n>1 in the form the caption states it.** At C=5 (n=50 sessions) the per-camera trackers land nowhere near 1/5 = 0.200 — they land far *below* it:

| tracker | within | cross | Δ (95% CI) | cross/within (95% CI) |
|---|---|---|---|---|
| LUC3D | 0.7494 | **0.7493** | −0.0001 [−0.0005, +0.0001] | **1.000 [0.999, 1.000]** |
| SLEAP per-camera | 0.1154 | 0.0616 | −0.0539 [−0.0652, −0.0433] | 0.484 [0.439, 0.531] |
| ByteTrack | 0.1574 | 0.0457 | −0.1117 [−0.1233, −0.1012] | 0.286 [0.275, 0.297] |
| 3D-MuPPET | 0.0112 | 0.0112 | +0.0000 [−0.0001, +0.0000] | 0.998 [0.992, 1.002] |

Note SLEAP's within-view IDF1 on BMimica is **0.115**, not 0.66 — so on this corpus SLEAP is already near the floor before pooling, and its collapse ratio is 0.484, not 0.2. Also LUC3D's within→cross flatness is Wilcoxon p=3.09e-08 (statistically non-zero, magnitude ≤0.007 in the worst session) — say "≤0.007 in every session", not "unchanged". The caption's "clearest evidence" (UDMT 0.157 ≈ 1/6) is still n=1.

## Q5 — `error_decomposition.csv`: a missing panel that *helps* you

| tracker | fp_total | fn_total | idsw_total | gt_total | mota_weighted | fp_share | fn_share | idsw_share |
|---|---|---|---|---|---|---|---|---|
| sleap | 62,320 | 5,509,232 | 3,608 | 15,947,278 | 0.650401 | 0.011178 | 0.988175 | 0.000647 |
| bytetrack | 51,049 | 5,627,679 | 12,305 | 15,947,278 | 0.643135 | 0.008970 | 0.988868 | 0.002162 |
| **luc3d** | **35,673** | 5,635,723 | 3,750 | 15,947,278 | 0.644131 | **0.006286** | 0.993053 | 0.000661 |

Components: false positives, false negatives, ID switches, against a common GT of 15,947,278 keypoint-instances. **This is the panel that pre-empts the "you only win because MOTA is flat" objection** — it proves >98.8% of every tracker's error is FN from the shared detector, so MOTA cannot discriminate trackers and its exclusion is principled, not convenient. LUC3D also has the fewest FPs (35,673, 43% fewer than SLEAP) at essentially equal FN. `panel_error_decomposition.png` exists in the bench and appears in no manuscript figure.

**The killer corollary, which I computed and which is in no file:** across the 74 sessions, Pearson **r(LUC3D session IDF1, shared-detector recall) = 0.980, p = 6.5e-52, R² = 0.960**; r(IDR, recall) = 0.9845 with mean |IDR − recall| = 0.029. **96% of the between-session variance in the headline within-view IDF1 is the detector's recall, not the tracker.** State this yourselves. A referee who finds it first will use it to dismiss the whole within-view comparison — including your own 3-animal limitation, which then reads as detector noise on n=4.

## Q6 — `by_bedding.csv`: bedding matters a lot, and it *complicates* Fig 6

Full table (44 black / 30 white sessions):

| tracker | bedding | mota | motp | idf1 | idp | idr | precision | recall | switches | frags |
|---|---|---|---|---|---|---|---|---|---|---|
| bytetrack | black | 0.726790 | 0.001222 | 0.587498 | 0.758574 | 0.556502 | 0.990890 | 0.732066 | 21.708 | 92.920 |
| bytetrack | white | 0.716546 | 0.000916 | 0.439230 | 0.599056 | 0.414573 | 0.989662 | 0.722639 | 36.522 | 173.606 |
| **luc3d** | black | 0.727735 | 0.001145 | **0.741095** | 0.945569 | 0.702770 | 0.992130 | 0.730850 | 7.212 | 8.405 |
| **luc3d** | white | 0.723063 | 0.000682 | **0.729738** | 0.937695 | 0.692592 | 0.990152 | 0.727375 | 10.256 | 6.228 |
| sleap | black | 0.732935 | 0.001212 | 0.693507 | 0.876347 | 0.661606 | 0.989503 | 0.738359 | 6.383 | 5.072 |
| sleap | white | 0.728408 | 0.000977 | 0.614290 | 0.795197 | 0.585759 | 0.987104 | 0.734781 | 10.683 | 2.767 |

**LUC3D is nearly invariant to coat/bedding contrast; the 2D trackers are not.** Black→white IDF1 penalty: **LUC3D +0.0071, SLEAP +0.0792, ByteTrack +0.1483** (per-session means; identical ordering on IDP: +0.0017 / +0.0813 / +0.1599).

**This complicates Fig 6's thesis.** Detector recall is essentially bedding-independent — black 0.7309 vs white 0.7274 for LUC3D (3,158,259 vs 2,476,993 misses over 8,838,002 / 7,109,276 GT), precision 0.9921 vs 0.9902. So bedding is a difficulty axis that does **not** act through missing keypoints; it acts through *appearance ambiguity*, and it damages identity assignment only for methods that depend on appearance. Fig 6's "difficulty manifests as missing keypoints rather than degraded ones" is true of the *hand-assigned difficulty rating* but false of bedding contrast, which is a separate, orthogonal axis. Either qualify Fig 6 to the difficulty rating specifically, or turn this into a strength: geometry-based identity is contrast-invariant, appearance-based identity is not. Caveat to state: bedding is confounded with animal count (all 3 four-animal sessions are black; 21/32 one-animal sessions are black).

## Q7 — `worst_idf1_luc3d.csv`: these are NOT LUC3D failure modes. The real ones are in `_diag/`.

The file, joined to covariates and to what SLEAP does on the same session (my computation):

| session | A | diff | bedding | frames | LUC3D | SLEAP | Byte | LUC3D IDP | LUC3D IDR | det recall | LUC3D sw | SLEAP sw |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10202022163211 | **1** | 6 | black | 59,742 | 0.0146 | 0.0210 | 0.0140 | **1.0000** | 0.0074 | **0.0074** | **0** | 6 |
| 10072022162233 | 2 | 7 | black | 18,086 | 0.0537 | 0.0797 | 0.0605 | 0.7672 | 0.0281 | 0.0389 | 32 | 14 |
| 10072022190807 | 3 | 7 | white | 18,221 | 0.0819 | 0.0875 | 0.0788 | 0.9464 | 0.0430 | 0.0462 | 3 | 12 |
| 10072022183527 | 2 | 7 | white | 18,029 | 0.0870 | 0.1003 | 0.0553 | 0.7592 | 0.0491 | 0.0674 | 153 | 86 |
| 10072022200754 | **1** | 5 | white | 81,052 | 0.1275 | 0.1243 | 0.1083 | **1.0000** | 0.0687 | **0.0687** | **0** | 24 |
| 10072022145420 | 4 | 4 | black | 18,255 | 0.1780 | 0.2046 | 0.2002 | 0.9447 | 0.1005 | 0.1068 | 112 | 35 |
| 10212022181154 | 2 | 6 | white | 41,568 | 0.2105 | 0.1920 | 0.1176 | 0.9403 | 0.1188 | 0.1244 | 84 | 111 |
| 10212022165516 | **1** | 2 | white | 108,133 | 0.2331 | 0.1598 | 0.1750 | **1.0000** | 0.1355 | **0.1355** | **0** | 25 |
| 10072022161055 | 2 | 7 | black | 18,249 | 0.2429 | 0.2595 | 0.1490 | 0.7414 | 0.1524 | 0.2241 | 191 | 113 |
| 10072022150448 | 4 | 4 | black | 19,142 | 0.2497 | 0.2563 | 0.2442 | 0.9457 | 0.1464 | 0.1529 | 16 | 11 |

**Three of the ten are single-animal sessions with LUC3D IDP = 1.0000 and 0 switches** — an identity tracker cannot fail there. In every row LUC3D's IDR ≈ the shared detector's recall (0.0074 = 0.0074 exactly on the worst one). Mean IDF1 in the worst-10: LUC3D 0.1479, **SLEAP 0.1485** — indistinguishable; the rest of the corpus is 0.8306 vs 0.7415. These ten are 400,477 of 1,954,440 frames (20.5%) and they are **detection blackouts, not association failures**. `final_report.md`'s claim that "they're cases with ≥3 animals + dense interactions" accounting for LUC3D's switch deficit is **wrong** — 3 of 10 are 1-animal, 0-switch sessions.

**The real failure-mode data is `_diag/error_episodes.tsv` + `ERROR_TAXONOMY.md`** — 681 episodes / 195,465 mislabeled frames (2.628% of 7,438,347 matched animal-frames) over 42 sessions (21 with ≥1 episode). An episode = ≥30 frames in which one GT animal is mislabeled in a *majority of the cameras that see it*:

| class | episodes | % eps | mislabeled frames | % frames | median dur | median onset gap | median dropout | median cams wrong | % recover | sessions |
|---|---|---|---|---|---|---|---|---|---|---|
| DROPOUT_REENTRY | 428 | 62.8% | 103,893 | **53.2%** | 91 f | 134.3 mm | **0.967** | 5 | 98.4% | 16 |
| CROWD | 144 | 21.1% | 48,486 | 24.8% | 130.5 f | **70.8 mm** | 0.700 | 6 | 95.1% | 5 |
| CROSSVIEW_LOCK | **36** | **5.3%** | 35,629 | **18.2%** | **578 f** | 117.9 mm | 0.133 | 6 | 88.9% | 14 |
| CLOSE_CROSSING | 73 | 10.7% | 7,457 | 3.8% | 69 f | 109.1 mm | 0.233 | 6 | 97.3% | 16 |

Per-session episode counts (n=21) for a CI: DROPOUT_REENTRY mean 20.4 (sd 21.0, median 14, max 70), CROWD 6.9 (sd 18.5, median 0, max 75), CLOSE_CROSSING 3.5 (median 2), CROSSVIEW_LOCK 1.7 (median 1, max 8). Also 72% of raw switches are FLICKER (<30 f, self-recovering) — `oscillation_frac=0.72`, and `long_swaps.tsv` has 1,379 sustained swaps over 20 sessions, median 272 f, p90 728 f, max 3,584 f; 456 at difficulty 6 and 587 at difficulty 7.

The referee-proof story: **53% of persistent mislabeling is occlusion re-entry (a temporal-linking problem), and the single worst class is your own method's characteristic failure — CROSSVIEW_LOCK, 36 episodes (5.3%) that are self-consistent across all 6 views and therefore invisible to the reprojection signal Fig 5 relies on, yet 18.2% of all bad frames.** Naming your own method's characteristic failure mode is exactly what buys credibility, and it closes the loop with Fig 5's "a keypoint wrong in a way every camera agrees on is invisible to this signal."

## Q8 — `per_camera_session_metrics.csv`: 1,332 × 28, and what it can replace

Shape **1,332 rows** (74 sessions × 6 cameras × 3 trackers) × 28 columns: `session, camera, tracker, difficulty, bedding, animals, mota, motp, idf1, idp, idr, idtp, idfp, idfn, num_switches, num_fragmentations, precision, recall, num_false_positives, num_misses, num_detections, num_objects, num_predictions, mostly_tracked, partially_tracked, mostly_lost, num_unique_objects, num_frames`. 11,726,640 camera-frames.

Per-session distributions available to replace any n=1 panel (n=74, session = mean/sum over 6 cameras, 95% bootstrap CI over sessions):

| quantity | LUC3D | SLEAP | ByteTrack |
|---|---|---|---|
| IDP | **0.9452** median 0.9998 [0.9233, 0.9655] | 0.8435 med 0.8656 [0.8145, 0.8707] | 0.6941 [0.6448, 0.7430] |
| IDR | **0.7005** med 0.8738 [0.6214, 0.7754] | 0.6309 med 0.7194 [0.5583, 0.7030] | 0.4990 [0.4298, 0.5698] |
| switches / session (6 cams) | 51.03 med **4.5** [33.4, 70.1] | 48.76 med 24.5 [36.8, 61.8] | 166.28 med 77 [122.9, 213.3] |
| fragmentations / session | 43.62 med 22.5 [28.0, 64.3] | **24.82** med 0.0 [8.7, 45.3] | 753.78 med 633.5 [606.3, 916.9] |

Two things to note. **(i)** Paired IDP, LUC3D−SLEAP = **+0.1017**, median +0.0603, 95% CI [+0.0713, +0.1346], **57/74 wins, p=2.51e-08** — the cleanest, largest, most defensible single-metric win in the corpus, and it appears in no manuscript figure. **(ii)** The honest negative: **LUC3D fragments more than SLEAP** — paired +18.80 per session, median +13.0, 95% CI [+11.19, +26.03], **p=1.96e-09** (though −710 vs ByteTrack, p=1.13e-13). Switches on the mean are tied (51.0 vs 48.8) but the *medians* diverge sharply (4.5 vs 24.5) — LUC3D is switch-free on most sessions and catastrophically switchy on a few, which is a survival-curve story, not a bar-chart story.

## Q9 — `PAF_3d_kalman/_diag/`: the n=42 version of "switches vs inter-animal distance"

The n=1 panel is `figs/out/fig3_continuity.json` → `switch_rate_by_distance`, computed on **session 10072022145420 only** (its own caveat says so: *"uses only the SLAP-2M hard session … the one session with an independent proofread 3D reconstruction"*). 10 deciles, 1,777–1,778 frames each, 152 switches total, a clean monotone collapse: 27 switches in decile 1 (6.1–42.2 mm) → 17, 22, 28, 30, 10, 4, 9, 5, **0** in decile 10 (107.2–199.1 mm). Note: `cont` is loaded at `figs/fig3.py:189` and **never used** — the panel is currently drawn nowhere, while `CAPTIONS.md` still lists it as Fig 7b. The captions file is stale relative to `fig3.py` (which now draws a two-panel n=74 Fig 7: within-view IDF1 per session, and IDF1 vs animal count).

**The n=42 version exists in two forms.**

*(a) Precomputed, in `G_keeptrack_3d6_summary.txt`* — 42 multi-animal sessions, 252 cam-tasks, RAW switches 3,594, SUSTAINED (min_run=30) 1,005, oscillation_frac 0.72; 1,243/3,594 (35%) of switches occur when only ONE animal is detected in that camera:

```
inter_animal_mm (3D):  switch [med=120 p10=60 p90=233 mean=143 n=2,351]
                       all    [med=165 p10=62 p90=316 mean=180 n=7,073,971]
depth_cam_mm:          switch [med=659 p10=539 p90=772 mean=649 n=3,594]
                       all    [med=701 p10=570 p90=793 mean=695 n=7,430,605]
bbox_area_px2:         switch [med=15,505 p10=6,067 p90=36,001 mean=18,794]
                       all    [med=23,092 p10=9,712 p90=42,453 mean=24,923]
```
Do **not** build the panel by mixing these two rows — the switch numerator's `inter_mm` comes from the tracker's own 3D (and is NaN for 1,243 events) while a frame-count denominator would come from GT 3D. I tried it: the resulting fixed-bin curve is **non-monotone** (peak 5.43 sw/10k at 100–150 mm, 1.67 at 200–300 mm, and a 25.8 spike in a 3,871-frame ≥500 mm bin). That artifact is what a hostile referee would seize on.

*(b) Self-consistent, reconstructed from `_diag/timelines/*.npz` (42 files, each with `matched` (6, nframes, nGT) + per-frame GT `inter3d` + `animals` + `difficulty`).* Both numerator and denominator from the same GT distances. 674,069 frame-transitions, 4,160 consecutive-frame switches (a +16% proxy for motmetrics' 3,594 — rate *ratios* are robust, absolute counts are not), 7,437,883 matched animal-frames. **Equal-exposure deciles, exactly the n=1 panel's construction:**

| inter-animal 3D distance (mm) | switches | animal-frames | **sw / 10k animal-frames** | sw / 10k frames |
|---|---|---|---|---|
| 3–56 | 1,760 | 743,780 | **23.663** | 290.07 |
| 56–78 | 867 | 743,787 | **11.657** | 144.39 |
| 78–100 | 472 | 743,794 | **6.346** | 76.50 |
| 100–125 | 349 | 743,792 | **4.692** | 52.09 |
| 125–156 | 302 | 743,782 | **4.060** | 41.37 |
| 156–196 | 191 | 743,786 | **2.568** | 25.12 |
| 196–237 | 124 | 743,789 | **1.667** | 17.57 |
| 237–271 | 64 | 743,795 | **0.860** | 9.24 |
| 271–314 | 19 | 743,789 | **0.255** | 2.82 |
| 314–618 | 12 | 743,789 | **0.161** | 1.76 |
| overall | 4,160 | 7,437,883 | **5.593** | 61.72 |

**Spearman ρ(bin midpoint, rate) = −1.000, p = 6.65e-64 — perfectly monotone across all ten deciles, a 147× fall from first to last.** Mean inter-animal distance at a switch = **81.3 mm** vs exposure-weighted mean **174.0 mm**. Session-level replication, split at the exposure-weighted median (155.8 mm), **n=42 sessions**:

- near (<156 mm): mean **13.834** sw/10k, median 8.807, 95% CI **[9.671, 18.525]**
- far (≥156 mm): mean **1.691** sw/10k, median 0.228, 95% CI **[0.595, 3.257]**
- paired difference: mean **+12.143**, median +8.137, 95% CI **[+8.645, +16.097]**, **near > far in 42/42 sessions**, Wilcoxon **p = 4.55e-13**
- per-session rate ratio near/far: median **9.54×**, geometric mean 8.43×, >1 in **42/42**

By animal count (n=42): 2 animals (35 sessions) 2,558 sw / 5,253,111 af = **4.869** sw/10k; 3 animals (4) 763 / 1,025,298 = **7.442**; 4 animals (3) 839 / 1,159,474 = **7.236**.

**The n=42 version is strictly stronger than the n=1 version**, and it de-risks a real problem: the n=1 session is *atypical* — its overall rate is 10.641 sw/10k vs a corpus median of 4.433, **rank 33/42** (i.e. among the worst). Same-construction n=1 curve for comparison: 42.75, 25.80, 16.93, 5.64, 7.26, 2.96, 1.61, 3.50, 0.00, 0.00 — noisy and floor-truncated at 0, because that session's whole distance range tops out at 200 mm while the corpus reaches 618 mm.

**Panel spec:** "ID-switch rate against inter-animal distance", log-y, ten equal-exposure deciles, the ten rates above, 42 faint per-session lines behind, annotation `n = 42 sessions, 674,069 frames, 4,160 switches; rate falls 147× from the closest to the farthest decile (Spearman ρ = −1.00); near/far ratio 9.5× median, 42/42 sessions`.

## Q10 — Top 3 missing results, ranked

**1. The per-session paired win-rate, cross-view (n=50) and within-view (n=74).** No figure states a win count. Panel: LUC3D beats SLEAP on **cross-view IDF1 in 50/50 BMimica sessions** (sign test p ≈ 8.9e-16) and on **within-view IDF1 in 49/74 SLAP-2M sessions** (paired Δ +0.0769, 95% CI [+0.0522, +0.1032], Wilcoxon p=1.33e-06); camera-session level 238/444 wins, 47 ties, 159 losses; 3-way argmax LUC3D 275 / SLEAP 157 / ByteTrack 12 of 444. Cross/within ratio 1.000 [0.999, 1.000] for LUC3D vs 0.484 [0.439, 0.531] SLEAP and 0.286 [0.275, 0.297] ByteTrack. This replaces an overlapping-CI argument with a count nobody can dispute, and it converts Fig 7c from "means with CIs" into "every session, no exceptions".

**2. The failure-mode taxonomy (n=42, 681 episodes, 195,465 mislabeled frames = 2.628%).** DROPOUT_REENTRY 428 eps / 103,893 f (53.2%, median dropout 0.967 — occlusion re-entry, a temporal-linking failure); CROWD 144 / 48,486 (24.8%, median onset gap 70.8 mm); **CROSSVIEW_LOCK 36 eps (5.3%) / 35,629 f (18.2%), median duration 578 f, ≥3 cameras wrong at once, median dropout 0.133** — the method's own characteristic failure, self-consistent across views and therefore invisible to the Fig 5 reprojection signal; CLOSE_CROSSING 73 / 7,457 (3.8%). Plus 72% of raw switches are <30 f flicker. Referees demand this panel; you already have it, complete with four rendered example videos in `_diag/grids/`. Pair it with the correction that the "10 worst sessions" are detection blackouts (3 of 10 are 1-animal, 0-switch, IDP = 1.0000; LUC3D 0.1479 vs SLEAP 0.1485 on those sessions).

**3. Bedding/contrast invariance (n=74) on top of the error decomposition.** Black→white IDF1 penalty **LUC3D +0.0071, SLEAP +0.0792, ByteTrack +0.1483** (IDP: +0.0017 / +0.0813 / +0.1599) while the shared detector's recall is flat (0.7309 vs 0.7274) — geometric identity is contrast-invariant, appearance-based identity is not. Sits alongside error decomposition (FN share 98.8/98.9/**99.3**%, LUC3D FP 35,673 vs SLEAP 62,320) and the fact that **r(session IDF1, detector recall) = 0.980, R² = 0.960** across 74 sessions. Together these three numbers make the within-view metric's limits explicit *in your own voice*, which is the only way to survive the "your within-view loss at 3–4 animals" line of attack — because at n=4 and n=3, with 96% of the variance being detector recall, that loss is not a measurement of your tracker at all.

**Runners-up worth a Supplementary panel.** (i) The survival curves (five already drawn in `metrics/plots/`, none used) — LUC3D clears IDF1 ≥ 0.9 on 37/74 sessions vs SLEAP 22/74. (ii) The **switch-reduction post-processors**, n=444, which directly retire the report's own "switches are essentially tied" admission: `PAF_3d_kalman/metrics/headline.csv` gives LUC3D+PAF(L1+flip-revert) **6.19** switches (−24% vs SLEAP's 8.13, IDF1 unchanged 0.738) and L1+tracklet-vote **4.00** (−51% vs SLEAP, IDP **0.958**, IDF1 0.728), plus `liezl_cross_view` at n=360 cam-sessions with IDF1 **0.8029**, IDP 0.9604, 3.84 switches, 1.75 frags. **Verify which of these is the shipped app before citing any of it** — see the provenance warning at the top; `outputs/metrics/`'s "luc3d" numbers already appear to be the PAF-L1 variant rather than the baseline.