I have everything. Here is my review.

---

# Hostile review — LUC3D Figs 1–7, second pass

Method: I read all seven rendered PNGs, all six generators, `nature.py`, `CAPTIONS.md`, `README.md`, recomputed every caption number from `figs/out/*.json`, and swept `luc3d-bench/outputs/metrics/` + `PAF_3d_kalman/_diag/`. Physical sizes measured from the PNG headers and the SVG declarations; type sizes decoded from the SVG (`font-size` is in mm; ÷0.3528 = pt).

**The prose strip did break things, and it broke the worst one silently.** Two of the seven figures cannot be submitted as rendered.

---

## BLOCKERS

**1. BLOCKER — Fig 4: panels b, c, d are drawn *on top of* panel a. `figs/fig4.py:161`.**
`sh_ = 30.0` (line 148) sets the three solver boxes to 30 mm. Line 161 then advances `y += 4.4`. Panel a's 30 mm is never added, so the b/c/d row starts 25.6 mm inside panel a's boxes. In the render: "Linear DLT" collides with "**b** Held-out reprojection error"; "Non-linear triangulation" with "**c** Effect of rejecting one view"; "Joint bundle adjustment" with "**d** Views contributing"; panel a's camera icons and rays cross all three y-axes, and panel d's "3D error (mm)" axis label is struck through by a camera glyph. The same 25.6 mm reappears as dead white space above the footer — which is the "is Fig 4 too sparse?" symptom: it is not sparse, it is 25.6 mm short of where the footer thinks it is. This is exactly the class of failure the prose strip introduces: the caveat text that used to sit between panel a and the plot row was moved to `CAPTIONS.md` (see the comment on line 158) and the `y +=` that accounted for it was reduced to the bare inter-block gap.
**Fix:** `y += sh_ + 4.4`. Figure becomes ~108 mm; both the collision and the dead space go.

**2. BLOCKER — Fig 7: the caption describes a figure that no longer exists. Every panel letter points at the wrong artwork.**
`fig3.py:387-544` was rebuilt (its own comment: *"Rebuilt on n = 74 sessions. The previous a/b were n = 1 session per point"*) and `CAPTIONS.md` was not.

| letter | what the artwork says | what CAPTIONS.md says |
|---|---|---|
| a | **Within-view IDF1 per session** (74 × 6 cams, swarm) | "Cross-view IDF1 as cameras and animals increase" |
| b | **Within-view IDF1 vs animal count** (n=74) | "ID switches against inter-animal distance" |
| c | **Bedding invariance** (n=74) | "Within- vs cross-view IDF1 for four trackers, 95% CI" |
| d | **Within- vs cross-view IDF1** (n=50 BMimica) | *no caption at all* |

Caption (c) actually describes panel **d**. Captions (a) and (b) describe the *superseded* design — they match `fig3_scale.json` and `fig3_continuity.json`, which `fig3.py:188-189` still loads and never uses.
Note this also invalidates the review brief's premise #4: **Fig 7 no longer has n=1 panels.** They were fixed. The stale caption is the problem.

**3. BLOCKER — Fig 1 is 236.7 mm tall (`fig1.svg height="236.7mm"`, PNG 4256×5594 @ 601 dpi).**
Nature Methods artwork plus caption must fit 180 × 247 mm. Fig 1's caption is ~1,050 characters ≈ 14 set lines ≈ 47 mm. Total ≈ 284 mm. There is no page it fits on. The practical artwork ceiling is ~185–200 mm; Fig 1 must lose ≥40 mm.
**Fix:** the cheapest 45 mm is panel b's bottom row (four post-re-ID tiles). Panel b's point is "before → after"; show it as one before/after *pair* on two cameras (4 tiles, not 8) and move the 4×2 grid to Extended Data.

**4. BLOCKER — Fig 4 caption contradicts the number printed on Fig 4.**
Caption: "the pre-#113 regression rate (**35%** of keypoints)". The artwork prints "pre-#113 option set: **39%** of keypoints regressed". `fig4.json` `worse_than_dlt`: 2,073,127 / 5,302,852 = **39.09%**. The 35% is `fig4_stride60.json` (217,318/614,301 = 35.4%), a superseded run. A referee comparing caption to figure finds this in ten seconds.

**5. BLOCKER — Fig 2 text crosses the 180 mm trim edge.**
`"DIFFERENT directions: 12.6 mm at 13° falls to 2.7 mm"` (5.4 pt, panel 2c right) ends at **180.3 mm**. It is clipped in the render. Fig 5's `24.6` bar label ends at exactly **180.0 mm** — zero margin.

---

## MAJOR

**6. MAJOR — Fig 4b/4c are n = 1 session, 1 calibration, and the data to fix it is already on disk.**
`fig4.json["sessions"] = ['20250827_141755']` — **one** session. `fig4_input.json` exported **50 sessions and 3 calibrations** (442 MB of `fig4_input.bin`); `fig4_measure.mjs` processed only `sessions[0]`. So "5,302,852 keypoints" is 5.3 M *correlated* keypoints from one recording — pseudo-replication, no between-session variance, no CI on the 6% or on 2.27 vs 2.35. These, not Fig 7's, are the remaining n=1 panels.
The footer prints "1 session(s), 1 calibration(s)" only because `m.get('n_sessions', 1)` **defaults** — the keys don't exist in `fig4.json`. It is right by accident.
**Fix:** loop `fig4_measure.mjs` over all 50; report the paired per-session median with a CI.

**7. MAJOR — Fig 4's claim is wrong-headed given its own data, and it leads with a negative result.**
The data: observed views DLT 1.676 → refined 1.575 (−6.0%); **held-out view DLT 2.274 → refined 2.348 (+3.3%, worse)**; refined beats DLT on only **11,982,778 / 26,514,260 = 45.2%** of held-out views — i.e. **DLT wins the majority (54.8%)** out of sample. Meanwhile panel d shows view count moving 3D error **4.75 → 1.22 mm, a 3.9× effect**, and panel c shows dropping one bad view moves the point up to **6.9 mm**.
So the figure currently leads a "triangulation is trustworthy" argument with a 6% in-sample gain that the module *enforces by construction* (the caption admits this) and that vanishes out of sample, and buries the 3.9× effect last — drawn from a *different corpus* (50 BMimica sessions via `fig2.json`) with no flag on the artwork.
**Fig 4's claim should be:** *"3D accuracy is set by how many views contribute and whether a bad one is rejected — 4.75 → 1.22 mm across view count and up to 6.9 mm from dropping one outlying view — not by the choice of solver, which changes the residual it minimises by 6% and generalises to a held-out view not at all."* That is a genuinely useful, defensible, and *positive* statement. Reorder to d → c → b, retitle, and demote panel a's three-box schematic to Methods (the DLT-vs-BA-vs-joint-BA naming point is a nomenclature correction, not a result).

**8. MAJOR — the vermillion problem is NOT fixed. It now carries 11 meanings, and its valence flips.**
`#D55E00` means: the track-label callout (1b), the 3D point (2a), the *unaided* condition (2b), the app's τ=20 px tolerance (2c), the exhaustive competitor (3a, 3e), 4 animals (3c), the shipped corr3d default (3d), DLT (4b), the ">10 px" bucket (5a), **LUC3D's own reprojection-ranking signal (5c) and its two stat tiles**, missing keypoints (6c), and **ByteTrack (7)**. In Figs 3/4/7 vermillion is the competitor; in Fig 5 it is the paper's own winning method. `#009E73` is equally overloaded and flips valence: LUC3D (3, 7), the app's refined solver (4b), the app's reprojection-aided protocol (2b) — but also "**≤5 px, good**" (5a) *and* "**>20 px, bad**" (6c).
**Fix:** freeze a 4-slot semantic palette for the whole set — green = LUC3D/our method, blue = a comparison baseline, vermillion = the failure/cost axis, grey = oracle/reference — and drive every quantitative encoding (thresholds, view counts, animal counts) from a *sequential* ramp, never from the categorical accents.

**9. MAJOR — Fig 5 panel a's entire text is 4.6–4.8 pt: 50 sub-5-pt runs.**
`fig5.svg`: 24 glyph-runs at **4.6 pt** (every bar value label, including the headline `24.6`) and 26 at **4.8 pt** (every camera name plus the legend). Nature's floor is 5 pt. At 4.6 pt Arial the cap height is 1.15 mm — the numbers a reader is *meant to read* are below the legibility floor, in a panel that is ~35% of the figure. Also `fig3.svg` 8 runs at 4.8 pt, `fig6.svg` 7 at 4.8 pt, `fig4.svg` 1 at 4.6 pt ("repeat"). **Fix:** raise the floor to 5.0 pt in `nature.py` and assert it at write time.

**10. MAJOR — Fig 5a reuses Fig 2a's two-anchor frame, so its headline 24.6 px is an artifact of a deliberately crippled solve.**
`fig5.py` reads `fig2-protocol.json` — the *same frame from the same 2-anchor triangulation* as Fig 2a ("the other 6 2.5–**24.6** px"). Fig 5 is about proofreading a fully-informed 3D, where residuals are ~1–2 px. The panel discloses it in 4.8 pt ("● = an anchor view: lowest by construction, the 3D was solved from these two") in vermillion — which no reader will connect to "therefore all six other bars are inflated by design". The caption calls it simply "what the app displays". **Fix:** re-stage panel a from an all-views solve, or drop it and give the space to panel c.

**11. MAJOR — Fig 7b draws a 4-point trend line whose last two points are n = 4 and n = 3 sessions.**
`by_animals.csv` cell sizes: 1 animal **32 sessions**, 2 → **35**, 3 → **4**, 4 → **3**. `fig3.py:459` `f.polyline` connects all four, no n per tick, no CI, and the two load-bearing cells are fully confounded (all 3 four-animal sessions are black bedding and difficulty 4). The caption's "over 74 SLAP-2M sessions" is true of the corpus and false of the claim.
**The honest n=74 framing that exists in the data:** plot the *paired per-session difference* LUC3D − SLEAP as a dot strip, one dot per session, n printed on each tick — 1 `+0.141 [+0.100,+0.184]` 25/32 wins; 2 `+0.039 [+0.014,+0.065]` 24/35; 3 `−0.027 [−0.068,−0.005]` **0/4**; 4 `−0.028 [−0.050,−0.007]` **0/3**; overall `+0.077 [+0.052,+0.103]`, 49/74, Wilcoxon p = 1.3 × 10⁻⁶. A reader who can literally count four dots cannot be misled. The direction of the 3–4 animal loss *is* robust (SLEAP wins every one of those 7 sessions individually) — say so, and say the n.

**12. MAJOR — Fig 6's headline attributes a 74-session result to 130 sessions and 12.0 M frames.**
"Across 130 proofread sessions and 12.0 million frames, session difficulty manifests as…" — but 10.9×, 1.29×, panel c and panel d are all **74 SLAP-2M sessions / 1,561,915 keypoints**, as the figure's own footer states. `fig6.py:252-253` extracts the BMimica and SLAP-2M corpus rows and **never uses them**; 130 and 12.0 M appear nowhere on the artwork. The 56 BMimica sessions carry 10.08 M of the 12.0 M frames (84%) and contribute nothing to the finding. Separately, 1,954,440 SLAP-2M frames is the sum over all **84** sessions, so the sentence pairs a proofread-only session count with an all-sessions frame count.

**13. MAJOR — Fig 3's "347 µs" is not the rate the figure extrapolates at, and the 38 CPU-yr is a hardcoded literal.**
`fig3.py:307-309` takes `next(...)` over configs **sorted ascending by hypotheses**, so the per-hypothesis rate used is the 2a×5c config's **254.4 µs**, not 347 µs (which is 3a×5c). The rate varies 243.8–347.2 µs across configs (a 42% spread) and is extrapolated across six orders of magnitude from one config. And `fig3.py:364` prints `"4a×6c ≈ 38 CPU-yr per session"` as a **string literal** — 38 yr requires 347 µs; at the 254 µs the open marker actually uses it is 28 CPU-yr. Two mutually inconsistent extrapolations on one panel.

**14. MAJOR — Fig 1b's own artwork refutes the sentence printed under it.** The caption on the panel reads "the same animal carries a **different track label in every view**", and `t127` is visible in *both* cam 1 topB and cam 4 topR. That is why `distinctTrackNames = 22` but `distinctTrackLabels = **26**`: three names collide across cameras (`track_89` cam0+5, `track_93` cam5+6+7, `track_127` cam1+4). The caption and panel both quote **22** while describing the **26** quantity — under-counting by exactly the collisions, which weakens the point the number exists to make. Also undisclosed: 2 of the 26 detections resolve to **no** identity (`Camera3_sideC/track_226`, `Camera7_sideR/track_95`), so "22 → 3 identities" is presented as a complete accounting and is not. **Use 26, and state 24 of 26 assigned.**

**15. MAJOR — Fig 1c prints a factually wrong camera breakdown.** `fig1.py:308`: `tops = [... if "top" in name or "mid" in name]` → **"5 overhead + 3 side cameras"**. The rig is `Camera0_mid, 1_topB, 2_topC, 3_sideC, 4_topR, 5_topL, 6_sideL, 7_sideR` = **4 overhead, 3 side, 1 mid**. `Camera0_mid` is the frontal view whose image is in panel b *and* panel c — a reader looks at a wall-facing view and reads "overhead".

**16. MAJOR — Fig 2's bolded lead is self-contradicted by panel b.** "at a **median 4.3 px correction** in the views never touched." 4.3175 px is the median *distance* from reprojection to the held-out detection. Panel b's own measured p = **0.32%** at τ=20 px means **99.68% of reprojections are accepted untouched** — the median *correction* is **0 px**. Say "a median 4.3 px offset from that view's own detection, of which 0.32% exceed the 20 px tolerance and need a correction."
Also in the same lead: "2.3–4×" mixes bases. At τ=20: C=5 → **2.49×**, C=8 → **3.96×**. 2.3× occurs only at τ=10, C=5. And 3.96× requires C=8, which panel b explicitly shades as **outside** the measured band (`measured (C ≤ 5)`). The caption presents an extrapolation as measured.

**17. MAJOR — Fig 2's Supplementary Note contains two false statements.** (i) "the 'all 5 views' 3D floor equals the RANSAC-Procrustes alignment residual to within 2–5% **in every session**" — 47/50 sessions, with three at **5.2%, 24.5%, 27.8%**. (ii) "0.142 vs 0.138" bone-length CV is the *median* from the superseded `fig2_12sessions.json`; `fig2.py:167-168` computes the **mean** over `fig2.json`, which is **0.1561 vs 0.1504**. (iii) The reference 3D's own reprojection error is quoted as **2.0 px** here, **1.92 px** in `fig4.py`'s docstring, **1.922** in README, and is **1.884 (p50) / 2.099 (mean)** in `fig4.json`. Four values for one quantity.

**18. MAJOR — `README.md` and `fig2.py`'s docstring are stale for Figs 2 and 4 throughout.** README's Fig 2 block reproduces `fig2_12sessions.json` exactly (12 sessions, 314,672 keypoints, 2.15 px) — the live file is 50 sessions / 1,277,424 kp / 2.671 px. Also stale: 3D-by-view-count 4.12/2.63/1.83/1.24 → **4.75/2.91/1.92/1.22**; r = −0.71 → **−0.657**; "13° → 8.25 mm" → **13.4° → 12.59 mm**; cross-view residual 1.85 → **2.584 px**. README's Fig 4 table: 5,866 keypoints → **5,302,852**; distortion 7.1 px → unrecorded anywhere in `fig4.json`. README is the document a co-author trusts; it currently disagrees with every rendered number.

**19. MAJOR — "median lens-distortion displacement 4.6 px" (Fig 4 Methods) is in no data file.** No `distort*` key in `fig4.json`; the string "4.6" is absent. It is `console.log`-only in `fig4_measure.mjs:138`. README says **7.1 px** (p95 20.3). Deposit it or drop it.

---

## MINOR

**20. MINOR — Fig 7c and 7d are the same chart type, same y-axis, different widths.** Both are 2-point slope plots of IDF1 on 0–0.85 with identical ticks. `fig3.py:522` gives d `bw2 − 30.0` while c gets `bw2 − 15.0`, so the two adjacent panels' slopes are **not visually comparable** — and readers will compare them. Merge into one panel with two x-pairs sharing one y-axis; that frees ~40% of the row.

**21. MINOR — Fig 7's "UDMT at 0.157 ≈ 1/6" collides with a different number printed on the artwork.** Panel d prints "ByteTrack 0.157 → 0.046" — ByteTrack's *within-view* IDF1 on 50 BMimica sessions is also **0.157**. UDMT is not in Fig 7 at all, its 0.157 is one 6-camera session, and panel d's 1/C line is hardcoded **1/5 = 0.2** (`fig3.py:516`). A reader reads 0.157 off the artwork and attributes it to the wrong tracker.
Worse, at n=50 the per-camera trackers land **far below** 1/C, not near it: SLEAP 0.115 → 0.062 (ratio 0.484), ByteTrack 0.157 → 0.046 (0.286). "Fall toward the 1/C bound" is not what the data shows. And LUC3D's flatness is Wilcoxon p = 3.1 × 10⁻⁸ — say "**≤ 0.007 in every session**", not "unchanged". Finally, citing 3D-MuPPET at IDF1 **0.011** as evidence that "LUC3D is not alone in having a cross-view mechanism" is self-defeating: a method producing garbage is trivially flat.

**22. MINOR — Fig 5's "2.3× what detector confidence achieves" is 2.3× better than a baseline indistinguishable from random.** Detector confidence captures **11.7%** at a 10% budget; random captures 10%. The honest ratio is 27% vs random's 10% = **2.7×**, which the panel already draws. And the ceiling matters: even the *oracle* reaches only **31.8%** at a 10% budget, so 68% of the needed correction is unreachable at that budget by any ranking. The caption gestures at this ("why the oracle line is well below 100%") without the number.

**23. MINOR — Fig 3 has three of five panels carrying no data** (a two-box schematic, a typeset cost function, and an analytic curve). A typeset equation is a Methods object, not a figure panel. Panel c also plots LUC3D's `C·A³` *operation count* on an axis labelled "log₁₀ **hypotheses** per frame" — LUC3D enumerates no hypotheses; that is a unit mismatch on a shared axis.

**24. MINOR — Fig 3's frame accounting hides a third of the corpus.** "137,264 of 137,266 frames" is correct, but **198,292** frames were considered and **61,026 (30.8%) skipped** as ineligible. Caption's "68% eligible" is the 2a×5c config alone; pooled it is **69.2%** (per-config 68.2 / 79.2 / 80.5%). Also "the response is flat for any 3D weight ≥ 1" is false at corr2d = 2, where corr3d = 1 gives IDF1 0.9401 and **100** switches vs the plateau's 0.9518 / 2. It is flat for corr3d **≥ 2**.

**25. MINOR — Fig 6 panel a is ~40% empty black.** Six tiny wireframe frustums and three tiny skeletons in a 90 × 55 mm black field, labelled "8 calibrated cameras" next to a panel b titled "One frame, **six** cameras". Same for Fig 1c's rig sub-panel. Both are the least ink-efficient panels in the set. Crop to the content bounding box (`rigFit()` already computes it).

**26. MINOR — Fig 6d's "Animals" column reads as ranges it does not contain.** `fig6.py:245` joins the *set* with an en-dash: stratum 4 renders "**1–2–4**" for {1,2,4} and stratum 3 "**1–3**" for {1,3}. Neither contains the intermediate count. The "Bedding" column is `b/w` on 6 of 7 rows — dead ink; drop it or give counts.

**27. MINOR — Fig 4's three sub-footers are misaligned by 2.4 mm.** `yb2` is defined at line 200, mutated at 205, then reused by panel d at line 271, while panel c uses its own `yb2c`. Panel c's footer aligns with b's *first* line and d's with b's *second*. Same shared-mutable-`y` root cause as blocker 1.

**28. MINOR — provenance mixing is unflagged on three figures.** Fig 4 a–c = 1 BMimica session, d = 50 BMimica sessions (via `fig2.json`). Fig 2 a = 8-camera HardFight, b/c = 5-camera BMimica. Fig 5 a = 8-camera HardFight, c = 74 SLAP-2M sessions. Fig 6 a = 8-camera SLAP-2M, b = 6 cameras, c/d = 74 SLAP-2M. Only Fig 2 states it.

**29. MINOR — Fig 7 rendered at 300 dpi; Figs 1–6 at 601 dpi.** Acceptable individually, inconsistent as a set.

**30. MINOR — dead loads and stale docstrings.** `fig3.py:188-189` loads `fig3_scale.json` and `fig3_continuity.json` and never uses them (they are the data behind the two stale Fig 7 captions). `fig3.py`'s docstring still advertises panels f, g, h that are not drawn. `fig5.py` loads `fig4.json` unused.

**31. MINOR — benchmark provenance hazard, flag before submission.** Three different runs sit in `luc3d-bench/outputs/metrics/`: `per_camera_session_metrics.csv` (May 18 06:55) gives LUC3D IDF1 **0.738301**; `by_tracker/by_animals/by_bedding/by_camera.csv` (May 18 01:55) give **0.736490**; `auc_summary.tsv` gives 0.7383. `PAF_3d_kalman/metrics/headline.csv` shows LUC3D **baseline = 0.73604** and LUC3D+**PAF L1** = **0.73809** — so the "luc3d" numbers in `outputs/metrics/` are closest to the **PAF-L1 variant, not the shipped baseline**. Fig 7b's 0.373/0.328 come from `by_animals.csv`; the same cells in `per_camera_session_metrics.csv` are 0.376364/0.329462. **Confirm which configuration is the shipped app, cite one file, and say which.**

---

## The single most important result still missing (question 5)

**The error decomposition, and the disclosure it forces.** `error_decomposition.csv`, against a shared GT of 15,947,278 keypoint-instances:

| tracker | FP | FN | ID-sw | FN share |
|---|---|---|---|---|
| SLEAP | 62,320 | 5,509,232 | 3,608 | 98.82% |
| ByteTrack | 51,049 | 5,627,679 | 12,305 | 98.89% |
| **LUC3D** | **35,673** | 5,635,723 | 3,750 | **99.31%** |

And the corollary I computed and which is in no file: across the 74 sessions, **r(LUC3D session IDF1, shared-detector recall) = 0.980, p = 6.5 × 10⁻⁵², R² = 0.960**; r(IDR, recall) = 0.9845 with mean |IDR − recall| = 0.029.

This is not an extra — **it changes how three of your figures must be read.** 96% of the between-session variance in the headline within-view IDF1 (Figs 7a, 7b) is the detector's recall, not the tracker. It simultaneously (i) proves >98.8% of every tracker's error is FN from the shared pool, so MOTA cannot discriminate and its exclusion is principled rather than convenient; (ii) shows LUC3D has **43% fewer false positives** than SLEAP at equal FN; and (iii) **disarms the 3–4 animal loss** — at n=4 and n=3 with R² = 0.96 on detector recall, that loss is not a measurement of your tracker. State it in your own voice. A referee who computes it first uses it to dismiss the whole within-view comparison.

**Runners-up, in order.**
- **The paired win count.** LUC3D beats SLEAP on **cross-view IDF1 in 50/50 BMimica sessions** (sign test p ≈ 8.9 × 10⁻¹⁶) and on within-view in **49/74** SLAP-2M sessions; camera-session level 238/444 wins, 47 ties; 3-way argmax **275 / 157 / 12** of 444. Currently one 5.2 pt text line under Fig 7a, never a panel. This replaces an overlapping-CI argument with a count nobody can dispute.
- **The failure-mode taxonomy** (`PAF_3d_kalman/_diag/`, n=42, 681 episodes, 195,465 mislabeled frames = 2.628%): DROPOUT_REENTRY 428 eps / 103,893 f (53.2%); CROWD 144 / 48,486 (24.8%); **CROSSVIEW_LOCK 36 eps (5.3%) / 35,629 f (18.2%), median duration 578 f, ≥3 cameras wrong at once**; CLOSE_CROSSING 73 / 7,457. CROSSVIEW_LOCK is your method's *characteristic* failure — self-consistent across all views and therefore invisible to the exact reprojection signal Fig 5 depends on. Naming it closes the loop with Fig 5's own caveat and buys the credibility that carries the 3–4 animal admission.
- **The survival curves** (five already rendered in `metrics/plots/`, none used). LUC3D clears IDF1 ≥ 0.9 on **37/74** sessions vs SLEAP's **22/74** — the separation is largest in the *upper* tail, which the mean hides. Also the honest negative you should pre-empt: LUC3D **fragments more** than SLEAP, +18.8 per session, 95% CI [+11.2, +26.0], p = 2.0 × 10⁻⁹.
- **Bedding invariance is under-sold and mis-framed.** Black→white IDF1 penalty LUC3D **+0.0071**, SLEAP **+0.0792**, ByteTrack **+0.1483**, while the shared detector's recall is flat (0.7309 vs 0.7274). This is a *mechanistic* result — geometric identity is contrast-invariant, appearance-based identity is not — currently a 5.2 pt annotation on Fig 7c. But note it **complicates Fig 6**: bedding is a difficulty axis that does *not* act through missing keypoints, so Fig 6's "difficulty manifests as missing keypoints rather than degraded ones" must be scoped to the hand-assigned difficulty rating specifically.
- **The n=42 switch-vs-distance curve exists** and is strictly stronger than the n=1 version the stale caption still promises. From `_diag/timelines/*.npz`, equal-exposure deciles, both numerator and denominator from the same GT distances: 23.66 → 0.16 switches per 10k animal-frames, a **147× fall**, **Spearman ρ = −1.000, p = 6.7 × 10⁻⁶⁴**; near/far median ratio 9.5×, **42/42 sessions**. The n=1 session currently behind that claim is *atypical* (rank 33/42, rate 10.6 vs corpus median 4.4) and its distance range truncates at 200 mm where the corpus reaches 618. Do **not** build it from `G_keeptrack_3d6_summary.txt`'s two rows — mixing tracker-3D switch distances with GT-3D exposure yields a **non-monotone** curve with a 25.8 spike, which is what a hostile referee would seize on.

---

## The five highest-priority actions

1. **Fix `fig4.py:161` (`y += sh_ + 4.4`) and re-render.** One line. Fig 4 is currently unpublishable — three panel titles are struck through by panel a.
2. **Rewrite Fig 7's caption a–d against `fig3.py:387-544`,** and fix Fig 4's caption 35% → **39%**. These are the two places where the caption and the artwork state different things; both are found in seconds.
3. **Cut Fig 1 from 236.7 mm to ≤190 mm** (drop panel b's second 4-tile row to Extended Data), and fix the two factual errors printed on it: **26** per-camera track labels (24 of 26 assigned), and **4 overhead + 3 side + 1 mid**, not "5 overhead + 3 side".
4. **Reframe Fig 4 around its own strongest data** — lead with view count (4.75 → 1.22 mm, 3.9×) and outlier rejection (up to 6.9 mm), demote the solver comparison — **and re-run `fig4_measure.mjs` over all 50 sessions** (`fig4_input.json` already has them; it is currently processing `sessions[0]` only).
5. **Add the error decomposition + the r = 0.980 detector-recall disclosure, and the 50/50 paired win count.** Either as a new Fig 7 panel replacing the merged 7c/7d, or as the first Extended Data figure. Then freeze the 4-slot semantic palette and raise the type floor to 5.0 pt (Fig 5a's 50 sub-5-pt runs are the worst offender).

---

## The hardest question a hostile reviewer asks

> *"Figure 1d tells me SLEAP already does multi-camera 3D (sleap-io + sleap-anipose) and already does annotation-time cross-view association (Maree et al. 2024, which you cite in your own capability table). Figure 3 tells me your greedy method reproduces that association on 137,264 of 137,266 frames — i.e. it is not more accurate, only faster. Figure 4 tells me the solver choice buys 6% on the residual it is built to minimise and nothing on a held-out view. Figure 7 tells me you lose to SLEAP on within-view IDF1 at 3 and 4 animals. So: what is the methodological advance here beyond a browser reimplementation with a different install story — and where is the result that only this tool made possible?"*

You currently have no answer on the artwork. Not one of the seven figures shows a biological finding obtained with LUC3D, and not one shows a throughput measurement — no annotator-hours, no wall-clock, no time-to-first-usable-dataset. Fig 2 measures *placements*, a model (`aided = 2N + (C−2)·N·p`), not time; `README.md`'s own Open section concedes "**wall-clock labelling time is still not measured**." The two things that are unambiguously yours and unambiguously new — that identity is consistent across views by construction (**≤ 0.007 drift in every one of 50 sessions**, vs 0.484 and 0.286 collapse ratios for per-camera trackers) and that it is **contrast-invariant** where appearance-based identity is not (+0.007 vs +0.079 and +0.148) — are the strongest cards in the deck and are currently a slope plot and a 5.2 pt annotation in the last figure's bottom row. Lead with them, and get a timing number before submission even if it is n = 3 annotators on one session.