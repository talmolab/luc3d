Audit complete. Findings below, organised per figure. Every "data" value is what I recomputed from the deposited JSON using the generator's own aggregation code path.

## Fig 1 — `figs/out/fig1.json`, `fig1-rig.json`; generator `figs/fig1.py`

| Caption claim | Data | Verdict |
|---|---|---|
| "8 cameras" | `cameras` = 8 (`Camera0_mid…Camera7_sideR`); `stats.nCameras` = 8 | **MATCH** |
| "three mice" | `nAnimals` = 3, `stats.groupsThisFrame` = 3, `with3dThisFrame` = 3 | **MATCH** |
| "22 per-camera track labels resolve to 3 identities" | `distinctTrackNames` = **22**, `distinctTrackLabels` = **26**, `tracked.identities` = 3 | **MISMATCH (wording)** — see below |
| "consistent across all 8 views" | panel divider prints the same; identities present in all 8 views | **MATCH** |
| "the rig with all 8 frustums" | `fig1-rig.json shots[*].nCams` = 8; panel label reads "rig: 8 calibrated views" | **MATCH** (wording differs) |

**The 22 vs 26 problem (material).** `fig1_tracking.mjs:130-132` computes two different things and its own log line names them correctly: `distinct` (cam+track pairs) = **26** is *"per-camera track labels"*; `distinctNames` = **22** is *"distinct names"*. The caption (and the panel divider at `fig1.py:241`) attaches the **22** value to the **26** wording. 22 < 26 only because three track names collide across cameras (`track_89` in cam0+cam5, `track_93` in cam5+6+7, `track_127` in cam1+cam4). Under-counting by exactly the collisions weakens the "no cross-view correspondence" point the number exists to make.

**Two detections resolve to no identity, undisclosed.** Of the 26 detections, only 24 got an identity. `Camera3_sideC/track_226` and `Camera7_sideR/track_95` have `identity: null` (spurious 4th detections; those two views have `nInstances: 4`). "22 … resolve to 3 identities" is presented as a complete accounting; it is not. Note the four cameras chosen for the panel (`PANEL_CAMS`, `fig1.py:39`) are exactly four of the six views that have no unassigned detection.

**Panel b shows 4 views, not 8.** Caption 1b says "One frame of an 8-camera recording … consistent across all 8 views" without stating that only 4 of the 8 tiles are shown. The 8 is carried only by the divider text.

**Unexplained on-panel numbers:** "5 overhead + 3 side cameras" (derived by substring-matching `top`/`mid` vs `side` on camera names — `Camera0_mid` is classified overhead by that heuristic); "15 nodes each"; "3 animals in 3D". None appear in CAPTIONS.md.

## Fig 2 — `figs/out/fig2.json` (50 sessions), `fig2_12sessions.json`, `fig2-protocol.json`; generator `figs/fig2.py`

| Caption claim | Data (fig2.json, generator's own aggregation) | Verdict |
|---|---|---|
| "2.3–4× fewer manual placements" | at τ=20: C=5 → **2.49×**, C=8 → **3.96×** (panel prints "At C = 8, 120 placements vs 30: **4.0×**"). 2.3× occurs only at **τ=10, C=5** (2.31×) | **MISMATCH** — range mixes bases |
| "median 4.3 px correction" | `held_out_vs_observation.p50` median = **4.3175 px** | **MATCH numerically / semantically wrong** |
| "n = 50 BMimica sessions" | `n_sessions` = 50, `per_session` len 50 | **MATCH** |
| "1,277,424 keypoints" | Σ`keypoints_used` = **1,277,424** | **MATCH** |
| "5 cameras, 2 mice" | `cameras` = {5}, `animals` = {2}, `nodes` = {15} | **MATCH** |
| "τ = 20 px is the app's own `reprojSigma` default" | `app_reproj_sigma_px` = 20.0; `ui/settings.js:246` `reprojSigma default: 20` | **MATCH** |
| "p the measured fraction that miss it" | panel: p = **0.32%** at τ=20, **40.1%** at τ=5 | **MATCH** (value absent from caption) |
| Supp. Note "reference 3D … its own reprojection error (**2.0 px**)" | `fig4.json reference_reproj_px.p50` = **1.884**, mean **2.099**; `fig4_stride60.json` p50 = **2.023**; `fig4.py` docstring says **1.92**; README says **1.922** | **MISMATCH / no single source** |
| Supp. Note "the 'all 5 views' 3D floor equals the RANSAC-Procrustes residual to within 2–5% **in every session**" | median 1.2163 mm vs median align `resid_med` 1.1998 mm (**1.6%** apart). Per session: **47/50 within 5%**, but three sessions off by **5.2%, 24.5%, 27.8%** | **MISMATCH** — "every session" is false |
| Supp. Note bone-length CV "**0.142 vs 0.138**" | fig2.json: **mean 0.1561 vs 0.1504** (what `fig2.py:167-168` computes); median 0.1487 vs 0.1468. `fig2_12sessions.json` median = **0.14175 vs 0.13782** | **MISMATCH** — stale, from the 12-session file, and uses median where the code uses mean |
| Supp. Note "~3% relative reduction" | mean-based reduction = **3.66%**; 613/700 edges lower | **MATCH** |

**The 4.3 px "correction" is self-contradictory with the model on the same panel.** 4.3175 px is the median *distance* from the reprojection to the held-out view's own detection. The placement model on panel b sets p = 0.32% at τ=20 — i.e. 99.68% of reprojections are accepted **untouched**, so the median *correction* is 0 px. Calling 4.3 px "the median correction" in the bolded lead is the single most attackable sentence in the file.

**The "4×" upper bound is extrapolated, undisclosed.** The panel explicitly shades "measured (C ≤ 5)". 3.96× requires C = 8, outside the measured band. The caption gives the range as if measured.

**README is stale (confirmed).** README's "12 BMimica sessions / 314,672 keypoints / median 2.15 px held-out" reproduces `fig2_12sessions.json` **exactly** (n=12, Σkp = 314,672, `held_out.p50` median = 2.1499). The live file is `fig2.json` (50 sessions, 1,277,424 kp, `held_out.p50` = 2.671, `held_out_vs_observation.p50` = 4.318). Also stale in README: 3D-by-view-count `4.12/2.63/1.83/1.24` (now **4.75/2.91/1.92/1.22**), `r = −0.71` (now **−0.657**), narrowest pair "13° → 8.25 mm" (now **13.4° → 12.59 mm**), cross-view residual median "1.85 px" (now **2.584**), CV "0.149 vs 0.142". `fig2.py`'s own docstring (lines 24-37) is stale the same way ("12 BMimica sessions … 314,672 keypoints … 0.149 for … 0.142").

**Uncaptioned panel-a numbers that undercut the headline:** panel a prints, from the app's own run, "anchor views 1.4–4.5 px" and "the other 6 **2.5–24.6 px**". The 24.6 px view **exceeds the τ = 20 px tolerance** the same figure defines as the accept threshold. Nothing in the caption acknowledges it.

Other uncaptioned on-panel numbers: `60% ≤ 5 px`, `99.7% ≤ 20 px`, `all 5 views 1.2`, `12.6 mm at 13°`, `2.7 mm at 32°`, `n = 10, r = −0.66`.

## Fig 3 — `figs/out/fig3_*.json`; generator `figs/fig3.py`

| Caption claim | Data | Verdict |
|---|---|---|
| "137,264 of 137,266 frames" | `frames_compared` = 137266, `agreement_rate` = 0.9999854 → 137264 agree, 2 differ; panel prints the same | **MATCH** |
| "10⁷× less at four animals" | extrapolated 48,612 s/frame vs LUC3D 0.00244 → 10^7.30, panel prints `10⁷×` | **MATCH** (as rounded) |
| "n = 8 sessions" | `fig3_sweep.json` 8 sessions, every cell `n_sessions` = 8 | **MATCH** |
| "the measured **347 µs** per hypothesis" (the rate the open marker is extrapolated at) | per-config: 2a×5c **254.4 µs**, 2a×6c 243.8 µs, 3a×5c **347.2 µs**. `fig3.py:308` takes the *first* config by ascending hypotheses → **254.4 µs** is what the figure actually uses | **MISMATCH** |
| "68% of frames are eligible" | pooled Σclean/Σconsidered = 137,266/198,292 = **69.22%**; per config 68.2% / 79.2% / 80.5% | **MISMATCH (mild)** — 68% is the 2a×5c config only |
| Supp. "the response is flat for any 3D weight ≥ 1" | at corr3d = 1, corr2d = 2 → IDF1 **0.9401** and **100** switches vs the plateau 0.9518 / 2 switches. Flat only for corr3d ≥ 2 | **MISMATCH** |

Also: the caption's "reproduces the exhaustive grouping" is the *partition* agreement (99.9985%). The same JSON records greedy IDF1 0.982 vs exhaustive 0.714 and 2 vs 76 switches — not plotted, not captioned. Defensible, but a reviewer who opens the JSON will ask.

Dropping "eligible" from "137,266 frames" hides that **198,292** frames were considered and **61,026 skipped**.

**Uncaptioned on-panel number:** "4a×6c ≈ **38 CPU-yr per session**" — a hardcoded string literal (`fig3.py:364`), derivable from no deposited field, and inconsistent with the caption's own 347 µs (which would give ≈52 yr).

**Dead loads:** `fig3_scale.json` and `fig3_continuity.json` are loaded (`fig3.py:188-189`) and never used. `fig3.py`'s docstring still advertises panels f, g, h that are not drawn.

## Fig 4 — `figs/out/fig4.json`; generator `figs/fig4.py`

| Caption claim | Data | Verdict |
|---|---|---|
| "lowers reprojection error by **6%**" | dlt p50 1.6760 → ba p50 1.5754 = **6.00%** | **MATCH** |
| "held-out DLT **2.27** vs refined **2.35** px" | `heldout_reproj_px.dlt.p50` = 2.2740, `.ba.p50` = 2.3484; panel prints 2.27 / 2.35 | **MATCH** |
| "pre-#113 regression rate (**35%** of keypoints)" | `worse_than_dlt`: 2,073,127 / 5,302,852 = **39.09%**. The rendered figure prints "pre-#113 option set: **39%** of keypoints regressed". 35% = `fig4_stride60.json` (217,318/614,301 = 35.4%) | **MISMATCH — caption contradicts the artwork** |
| "median lens-distortion displacement **4.6 px**" | not in `fig4.json` (no `distort*` key; string "4.6" absent). Only `fig4_measure.mjs:138` console-logs it. README says **7.1 px** | **NOT-FOUND-IN-DATA / UNVERIFIABLE** |

README's Fig-4 table is stale in full: 5,866 keypoints → now **5,302,852**; DLT p50 1.679 → **1.676**; BA 1.577 → **1.575**; "2296/5866 (39%)" → **2,073,127/5,302,852 (39.1%)**; distortion 7.1 px → unrecorded. The **39%** figure is the one README and `fig4.json` agree on, so it is the caption's 35% that is out of step, not the README.

**Provenance contradiction on the artwork.** The footer prints "5,302,852 keypoints, **1 session(s)**, 1 calibration(s)" (`n_sessions`/`n_calibrations` are absent from `fig4.json`, so `.get(...,1)` defaults), while panel d prints "band = p25–p75 across **50 sessions**" because panel d reads `fig2.json`, a different corpus. Neither the caption nor the footer flags that a-c and d come from different data.

**Uncaptioned panel-c elements:** worst-view strata "< 3 / 3–10 / ≥ 10" px, n = 3,154,613 / 2,098,267 / 49,972, shifts 1.0 / 2.5 / 6.9 mm, and "refined wins 45% of 26,514,260 held-out views". The 45% is the direct quantitative counterpart to the caption's held-out claim and is not in the caption.

## Fig 5 — reads `figs/out/fig6_detections.json` (+ `fig2-protocol.json`, `fig4.json` loaded, `fig4.json` unused); generator `figs/fig5.py`

| Caption claim | Data (`fig6_detections.json`) | Verdict |
|---|---|---|
| "27% of the needed correction from a 10% review budget" | weighted-mean `capture_reproj_10` = **0.26953**; panel prints "27% found by reviewing 10%" | **MATCH** |
| "2.3× what detector confidence achieves" | 0.26953 / 0.11720 = **2.2998**; panel prints "2.3×" | **MATCH** |
| "85% of a perfect oracle" | 0.26953 / 0.31823 = **0.8469**; panel prints "85%" | **MATCH** |
| "n = 74 SLAP-2M sessions" | `n_sessions` = 74; `sessions` len 74; Σ`by_difficulty[*].n_sessions` = 74 | **MATCH** |
| "1,561,915 keypoints" | Σ`n_keypoints` = **1,561,915** | **MATCH** |
| "ρ = 0.69" | weighted-mean `spearman` = **0.69048** | **MATCH** |

Fig 5 is the cleanest figure in the set — all six numbers reproduce exactly.

One omission: panel a's residual bars come from a deliberate **two-anchor** solve, and the panel itself says "● = an anchor view: lowest by construction". The caption describes panel a only as "what the app displays" and never mentions the anchors or that the residuals shown are inflated by design. The generator's own footer discloses it; the caption does not.

## Fig 6 — `figs/out/fig6.json`, `fig6_detections.json`, `fig6-app.json`; generator `figs/fig6.py`

| Caption claim | Data | Verdict |
|---|---|---|
| "130 proofread sessions" | Σ`sessions_with_3d` = 56 + 74 = **130** (of 140 total) | **MATCH** (but not on the figure) |
| "12.0 million frames" | 10,084,734 + 1,954,440 = **12,039,174** | **MATCH with a caveat** — see below |
| "miss rate rises **10.9×**" | 5.31% → 57.90% = **10.8975×**; panel prints "10.9× rise" | **MATCH** |
| "error of detections that do fire rises **1.29×**" | 3.666 → 4.725 = **1.2888×**; panel prints "1.29× rise" | **MATCH** |
| "(d) Corpus composition by stratum" | table rows reproduce `by_difficulty` exactly: sessions 12/13/9/13/10/4/13 = 74; keypoints 252,265/342,287/229,072/245,731/273,748/91,922/126,890 = 1,561,915; miss 5.3/10.5/23.0/22.2/22.5/46.0/57.9; err mean 3.67/3.60/4.24/3.97/4.17/4.52/4.72 | **MATCH** |

**The headline welds two different corpora.** "Across 130 proofread sessions and 12.0 million frames, session difficulty manifests as…" — but every measured quantity in that sentence (10.9×, 1.29×) and both data panels (c, d) are **74 SLAP-2M sessions / 1,561,915 keypoints**, which the figure's own footer states. `fig6.py:252-253` extracts the BMimica and SLAP-2M corpus rows (`bm`, `sl`) and **never uses them** — so 130 and 12.0M appear nowhere on the artwork. The 56 BMimica sessions (10.08M of the 12.0M frames, 84% of the frame count) contribute nothing to the finding the sentence attributes to them.

Also: the SLAP-2M `frames_total` = 1,954,440 is the sum over **all 84** sessions (10 have no `frames` field and 74 have 3D), so "130 proofread sessions **and** 12.0 million frames" pairs a proofread-only session count with an all-sessions frame count.

**Panel d's "Animals" column is misleading.** `fig6.py:245` joins the *set* of animal counts with an en-dash: stratum 4 renders "**1–2–4**" for the set {1,2,4} and stratum 3 renders "**1–3**" for {1,3}. Both read as ranges; neither stratum contains the intermediate counts.

**Uncaptioned panel-c sub-plot:** a third axis "beyond 20 px tolerance (%)" with per-stratum values 0.3/0.4/1.5/0.8/1.0/1.5/1.8 and "**5× rise**" (5.3436×). Caption 6c mentions only "detection quality" generically.

**Panel a is one rig, not the corpus.** `fig6-app.json` is the SLAP-2M session (8 cameras, 4 animals); the label reads "8 calibrated cameras". The corpus spans a 5-camera rig (BMimica) and an 8-camera rig; the caption's "(a) The rig as rendered in the app" implies a single rig.

## Fig 7 — generator is `figs/fig3.py` (second half, writes `fig7.svg`)

| Caption claim | Data | Verdict |
|---|---|---|
| "50 full sessions" | `bmimica_50_sessions[*].within.n_sessions` = 50 | **MATCH** (panel d only) |
| "IDF1 unchanged 0.749 → 0.749" | LUC3D within mean 0.749382, cross mean 0.749254; panel prints "0.749 → 0.749 ×1.00" | **MATCH** |
| "UDMT at 0.157 ≈ 1/6" | `hard_session_slap2m["UDMT (off-pool, per-camera)"].cross` = **0.15743** | **MATCH numerically / wrong context** |
| "3D-MuPPET's `dmin` was retuned 200 → 100 mm" | `scripts/bartul/muppet_run.py:143` `--dmin default=100.0`, help "pigeon paper=200; mice smaller"; every result JSON has `dmin_mm: 100.0` | **MATCH** |
| "3 animals 0.373 vs SLEAP 0.403" | `by_animals.csv`: luc3d 0.3727986729, sleap 0.4030043982 | **MATCH** |
| "4 animals 0.328 vs 0.357" | `by_animals.csv`: luc3d 0.3283020378, sleap 0.3571084606 | **MATCH** |

**The Fig 7 caption describes a figure that does not exist — the most serious finding in the audit.** Rendered `fig7.svg` panels vs caption:

| Panel | Generator's actual title | Caption's description |
|---|---|---|
| a | **"Within-view IDF1 per session"** (n = 74 SLAP-2M × 6 cams) | "Cross-view IDF1 as cameras and animals increase" |
| b | **"Within-view IDF1 vs animal count"** (n = 74) | "ID switches against inter-animal distance" |
| c | **"Bedding invariance"** (n = 74) | "Within- vs cross-view IDF1 for four trackers; session-level mean with 95% bootstrap CI" |
| d | **"Within- vs cross-view IDF1"** (n = 50 BMimica) | *no caption at all* |

Caption (c) actually describes panel **d**; captions (a) and (b) describe content that is not drawn anywhere (they match the *unused* `fig3_scale.json` and `fig3_continuity.json`, i.e. an earlier figure design); panels a, b, c are uncaptioned. Every panel letter in the submission would point at the wrong artwork.

**The 0.157 collision.** Panel d prints "ByteTrack 0.157 → 0.046" — ByteTrack's *within-view* IDF1 on the 50 BMimica sessions is **0.157**, the same number the caption attributes to *UDMT's cross-view* IDF1. UDMT is not in the figure at all, its 0.157 comes from **one** SLAP-2M hard session on a 6-camera rig, and panel d's "1/C" reference line is hardcoded at **1/5 = 0.2** (`fig3.py:516`), not 1/6. A reader will read 0.157 off the artwork and attribute it to the wrong tracker.

**Uncaptioned on-panel numbers:** "LUC3D 275/444 SLEAP 157/444 ByteTrack 12/444 camera-sessions won"; panel a medians 0.90 / 0.75 / 0.50; "SLEAP ahead here"; bedding deltas Δ0.011 / Δ0.079 / Δ0.148; the ×-ratios 0.53 / 0.29 / 1.00.

---

### Priority fix list
1. **Fig 7 caption is written against a superseded panel layout** — rewrite a-d against `fig3.py:387-544`.
2. **Fig 4: "35%" contradicts the printed "39%"** — the figure reads `fig4.json` (39.1%); 35% is `fig4_stride60.json`.
3. **Fig 2: "median 4.3 px correction"** contradicts p = 0.32% on the same panel; and "0.142 vs 0.138" is the 12-session file's median while the code averages the 50-session file (0.156 vs 0.150).
4. **Fig 3: "347 µs"** is not the rate the extrapolation uses (254 µs); "flat for corr3d ≥ 1" is false at corr2d = 2.
5. **Fig 2: "within 2–5% in every session"** — 3/50 sessions exceed 5% (worst 27.8%).
6. **Fig 6: 130 sessions / 12.0 M frames** are not on the figure and are not the basis of the 10.9×/1.29× finding (74 SLAP-2M sessions are).
7. **Fig 1: 22 vs 26**, and the two identity-less detections.
8. **Fig 4: "4.6 px" distortion** is console-only — deposit it in `fig4.json` or drop it.
9. **README** is stale for Figs 2 and 4 throughout (it tracks `fig2_12sessions.json` and a 5,866-keypoint Fig-4 run); `fig2.py`'s docstring is stale identically.