# Adversarial review round — 2026-08-17

Five hostile agents, one lens each: captions-vs-data, Reviewer-2 science attack,
artwork legibility/honesty, cross-reference integrity, and a fig10 benchmark
rig-check. Every finding was required to be verified against deposits/scripts
before being reported; the consolidator (below) independently re-verified the
BLOCKER/MAJOR items before fixing anything. Fix disposition is recorded per
finding after the fix wave.

## Agent 4 — cross-reference integrity (REPORTED FIRST; 38 findings)

Headline: FIGURE-LEGENDS.md and METHODS.md are nearly current (one critical each);
RESULTS.md was re-lettered for Fig 1 only — its Fig 3, 6 and 7 sections narrate the
previous generation of panels AND data; CAPTIONS.md Figs 3/6/7 and README.md's
letters predate everything; FIGURES-PLAIN-ENGLISH.md is half-updated.

CRITICAL: (1) RESULTS cites cut bedding panel 7B; (2) legend Fig 6E describes the
replaced per-camera panel (should be IDF1-by-difficulty, 42 sessions);
(3) CAPTIONS Fig 3 section is a pre-refactor fossil (letters + 4-session data);
(4) CAPTIONS Fig 7 ditto incl. P=0.64-vs-P=0.008 contradiction; (5) CAPTIONS Fig 6
letters shifted, two placed panels uncaptioned.
HIGH: RESULTS fig3 letters all off by one (3C→3B, 3D→3C, 3F→3E, 3E→3D) and fig3
numbers from the old 4-session run; RESULTS 4.27px (deposits say 4.32); RESULTS
6C→6G; RESULTS 7D→7C, 7G→7F, old fig7 number set (+0.075/0.024/P=0.64/0.749/24
frags) vs current (+0.091/+0.052/P=0.008/fresh-anchor 0.861/+6.2); legend fig1
ledger 24/20 → 25/21; CAPTIONS fig1 contradicting bullets; CAPTIONS 4.4x/2.7x →
4.6x/5.2x; README misgroup counts; PANEL-SOURCES false MISSING rows (make_docs.py
cannot parse dynamic save() calls).
MEDIUM: RESULTS 2C/4C describe superseded panel forms; extremes 12.6mm@13°/2.7mm@31°;
CAPTIONS fig2 stride-200-era numbers; "three solvers"→two cards; 17→18 pairings;
FPE ledger + fig3 third-variant numbers + old fig6/7 letters; README fig1/3/6/7
letters; PANEL-SOURCES two broken Deposit paths; fig10/fig11 PANEL-SOURCES rows.
TERMINOLOGY: "1/C is a ceiling" (RESULTS/CAPTIONS) vs "scoring convention, not a
ceiling" (legend/METHODS — current form); RESULTS never names the fresh-anchor
configuration though three panels draw it; "exhaustive enumeration" naming variants;
one "out of sample" → "held-out".
(Full table in the agent transcript; fixes recorded below after the fix wave.)

## Agent 3 — artwork legibility + honesty (1 BLOCKER, 4 MAJOR, 9 MINOR)

BLOCKER: Fig 6E legend/artwork mismatch (corroborates Agent 4 #2).
MAJOR: (2) set-wide hue collisions — salmon = exhaustive (fig3) = app DLT (fig4)
= ByteTrack (fig7) = BEDDING (fig10/11); teal = LUC3D (3/7) = TRIADS (10/11);
periwinkle = SLEAP (7) = SCN2A (10/11); fig11 shows both meanings on one page.
Minimal fix: recolor the three fig10/11 dataset families to non-entity hues.
(3) Fig 5A legend claims "Scale bar, 93 mm" — not drawn on the Blender panel.
(4) Fig 2A cam6 tile: id_0 label buried under id_1. (5) Fig 10f legend
"TRIADS/BEDDING < 1 per 100k at every k" contradicted by drawn TRIADS k=3 ~1.2.
MINOR: fig2b key/axis + curve/note collisions; fig3e "exhaustive" label clipped
by its curve; fig5b n-text on the t=0 line; fig10c/g undeclared nonlinear sigma
axis (fig3d declares its log axis — match); fig10a ASCII "--" in captions;
fig6d difficulty-7 marker occlusion; fig4d/e unexplained hollow/hatch for
"Anipose optim"; fig1c/d unexplained red residual strokes in app tiles;
fig7a/11a unlabeled 0.2 rule with corpus note sitting on it.
Verified clean: fig1 counts/story, fig5b-g numbers, fig6 c/d/f/g/h, fig10
b/c/d/e/g numbers vs marks, fig11 no new collisions, bars start at 0.

## Agent 5 — fig10 benchmark rig-check (0 BLOCKER, 4 MAJOR + disclosure, 9 MINOR)

Verdict: NOT rigged — scorer is textbook IDF1 (global Hungarian, unmatched_det=0
everywhere), shuffle is per-(frame,view) with zero non-geometric channel, controls
reproduce exactly, and no unplaced arm (C7b/c/e/f, C8, C2_drop0.1) would flatter
the placed panels. Casualties are legend sentences and provenance:
MAJOR: (1) "falling monotonically" false (BEDDING 7.8->9.3 k5->6; SCN2A 27->31
k3->4; only TRIADS monotone); (2) "gap widens at sigma3" false for SCN2A (narrows
0.156->0.115) and BEDDING (COM better both times) — scope to TRIADS; (3) false
provenance: 3.0/5.9mm swap approaches, ~45mm contact, "two revert", ">0.999
grouping in worst cell", bout counts — none in deposits (swapdiag outputs were
rm'd with work dirs AND ran under seed 0, not the scored cells' seeds;
grouping_accuracy empty for 462 pre-metric rows); (4) pre-registered C0 defaults
audit never ran — the zero-retuning claim rests on code comments.
DISCLOSURE: panel f/g conditions settled after inspecting a wider measured matrix
(4 revisions); C5 never run; C2 node dropout shipped iid, not p_max-ordered.
MINOR: "TRIADS/BEDDING <1/100k" (TRIADS k3 = 1.11); "6-8 at 50%" clips TRIADS 5.6;
scorer sw_per_100k actually per-detections (panels recompute correctly; CSV header
misleads); switch tie-break toward higher id undocumented; 3.48M is all-41 total
(zero-switch 36 hold 3.06M; proximity counts verified exact); ~25min -> 22.9min;
"(see f)" points at wrong panel; 1e-13 -> <=1e-11 (cam6 3.6e-12); fig10_03/08
docstring rot; panel-d "BETWEEN two drawn points" comment false (SCN2A 10% above
its 0% endpoint — single-seed variance worth a methods sentence); two unscoped
generalizations ("Skeletons, not centroids...", "even an opposite pair...").
Verified exhaustively clean: every other legend number incl. 10,408/68,560 exact,
0.92 fig8 commensurability, controls, C6, throughput.

## Agent 2 — Reviewer-2 science attack (3 BLOCKER, 10 MAJOR, 7 MINOR)

BLOCKERS: (1) RESULTS still presents the RETRACTED white-bedding invariance as a
finding, citing cut panel 7B, with numbers mixed from two tracker arms (0.012 =
retired pre-#131 row; shipped drop is 0.0151, fresh-anchor 0.0028). (2) Fig 5's
quoted sign test (14/14, P=1.2e-4) and both Wilcoxons test a LARGER-OF-TWO
statistic against 0.5 — significant by construction under a fair coin; METHODS
itself says the statistic cannot fall below 0.5 two sentences earlier. Valid
replacements exist in-repo (simulated band 16/24, per-pair binomials 8/14).
Legend's "among those" wording additionally reads as selection-on-significance.
(3) RESULTS is a 2026-08-12 numeric snapshot (corroborates Agent 4): fig3
4,572,172/1,052/1,309/642/449/192 are the CAPPED pass (current: 4,591,864/940/
1,453/672/592/79); "69%" eligibility is actually 47.4%; fig3 sweep quotes the
retired 8-session grid; fig7 quotes the pre-#131 arm (+0.075/0.024/P=0.64 →
current +0.091/+0.052/P=0.008 — a null that is now significant); 0.749/0.749 vs
drawn fresh-anchor 0.861; frag mean 24 vs +6.2. REVERSE cases where RESULTS is
current and the LEGEND is stale: fig2 tolerance numbers (RESULTS 4.27/94.6/99.6
= every-frame out/fig2.json; legend 4.32/59.9 = retired stride-200) and fig1
ledger (RESULTS 25/21 right, legend 24/20 stale).
MAJORS: (4) Fig 4C's "50 of 50 slope down" is scored only on kept views — true
by construction; the repo's own fig4_measure.mjs says so; no held-out scoring of
the drop is deposited; RESULTS' "figure printed under the axis" is dead code.
(5) Fig 10 header "shipped configuration" vs the SAME operating point labeled
EXPERIMENTAL in Figs 3/7 and METHODS — cross-figure contradiction (branch-default
vs app-shipped). ERIC DECISION: promote config to shipped everywhere, or relabel
fig10 as fresh-anchor. (6) Fig 10e GT-provenance confound: COM arm's GT is the
COM tracker's own instance indices (plan §6.3 concedes; legend omits); BEDDING,
the one like-for-like cell, shows COM >= keypoints; sigma3 parenthetical false
for SCN2A; SCN2A COM 90k vs keypoint 89k frames. Fix: like-for-like com3d_used
cells or cut the causal sentence. (7) LEGEND-fig10 misstates deposits in 8
places (overlaps Agent 5; adds the sigma20-above-ceiling seed caveat).
(8) Fig 5F pooled 80% never compared to its own null — fair-coin pooled
expectation is 59.1%, computed nowhere. (9) METHODS promises Holm-corrected
counts; none published (16/24 -> 9/24 lives only in CAPTIONS). (10) "It is not
body size" hides that the leader is the SHORTER animal in 28/36 sessions
(P=0.0012) — direction of a threshold artifact; the absolute-60mm control
(24/24) is the strong counter and should lead. (11) = 6E legend (corroborated
3x). (12) METHODS Fig 2 internal contradiction: every-frame claim vs stride-200
solve counts (12.77M/38.3M) in one paragraph. (13) Fig 3 headline welds
easy-config agreement (shipped-arm count) to a 4x6 cost bound where zero frames
ran, while the panel features the fresh-anchor arm.
MINORS: fig6 heading leans on mean 1.30x while its own tail is 5.72x + censoring
untested; METHODS "every session that has both" excludes 32 single-animal
sessions silently; fig10 n=41 lacks the 6-rats-round-robin independence caveat +
chance level never anchored; "usually already correct" heading (detector
agreement); fig1C legend ledger; 6D non-monotonicity on n=3; fig3D exhaustive
IDF1 0.400 rule drawn despite deposit's own "do not cite" caveat.

## Fig 10 provenance-repair agent — results (a19c8b82, completed)

Additive-only repair run addressing Agent 5's MAJORs #3/#4. No scored cell was
modified; all deposits under `fig10-bench/results/agg/`.

1. **C0 defaults audit — 4/4 PASS** (`results/agg/c0_audit.json`).
   `fig10_bench.mjs` now emits `effectiveConfig` (threshold source + the fields
   a CrossViewTracker constructed via the real createTrackerRun path holds).
   One full C1_sigma0 cell per dataset re-run under the exact cell_seed
   (triads 764965355, bedding 3613850846, soc1 2407684417, soc3 2833440064):
   sync association, stale=20, distThresh=25, corr3d=6, corr2d=1, velThresh=10,
   timePenalty=0.1, maxTargets=animal count, all nodeWeights=1 — identical in
   both the settings source and the constructed tracker.
2. **Swap diagnostics under correct seeds — deposited, ONE CLAIM CHANGED**
   (`results/agg/swapdiag/<dataset>__<session>.json`, 5 sessions). Every
   session reconciles exactly with its scored cell (2 switches each; scorer's
   exact majority rule + consecutive-observed-frame counting).
   CONFIRMED: 3.0 mm (measured 2.96), 5.9 mm (5.87), ~45 mm (45.08) trigger
   distances; bedding swap early at frame 2723/90000.
   **CHANGED: "two of which revert within the session" is FALSE under the
   scored seeds — only ONE reverts** (soc1/2022_09_23_M3_M2: a single-frame
   flip-and-back at frames 11039–11040, tracks 0.70 mm apart). The other four
   swaps persist to session end. → LEGEND-fig10.md line ~62 fix.
3. **Worst-cell grouping — CONFIRMED** (`results/agg/worstcell_grouping.json`).
   bedding/2024_05_07_F5_F3 C2_drop0.5 re-run under seed 1330997939:
   idf1 0.540967 byte-exact vs scored; grouping_accuracy 0.999818, frames
   perfectly grouped 0.999314 — the ">0.999" legend claim and the plan's
   "0.9998" both stand.
4. **Contact bouts — deposited, ONE NUMBER OUTSIDE CLAIMED BAND**
   (`results/agg/contact_bouts.json`, new `fig10_contact_bouts.py`; <100 mm min
   inter-animal COM distance, maximal runs). Mean bouts/session:
   bedding 78.0 ✓, triads 177.17 ✓, soc1 159.57 ✓, **soc3 129.87 — outside the
   claimed "~160–177 elsewhere" band**. → wording becomes "~130–177".
5. Code hygiene: `fig10_score.py` docstring now states sw_per_100k is per 100k
   GT detections (JSON key unchanged); switch tie-break (toward higher identity
   id) documented at the vote site; `fig10_swapdiag.py` takes
   --seed/--out/--scored and cross-checks the scored cell's switch count.

Net new doc fixes for the wave: LEGEND-fig10 "two revert" → "one reverts
(a single-frame flip-and-back)"; bout band "~160–177" → "~130–177" in
LEGEND-fig10 + PLAN findings blocks.

## Agent 6 — captions vs data (numbers vs deposits), completed

Scope: FIGURE-LEGENDS.md, RESULTS.md, METHODS.md, s-dannce-bench/LEGEND-fig10.md
vs the actual deposits. ~390 quantitative claims checked. Headline: FIGURE-LEGENDS
is in very good shape except two stale panels (1C ledger, 6E panel swap); RESULTS'
Fig 3 and Fig 7 sections are the pre-redesign generation throughout; METHODS is
current except the sampling paragraph and four Fig-4 timing/geometry constants;
LEGEND-fig10 largely verified with boundary-value overstatements.

BLOCKERS:
 1. LEGENDS 1C "24 detections / 20 names" -> deposit says 25/21 (24 assigned + 1
    unassigned), frame 198. RESULTS is right.
 2. LEGENDS 6E describes the RETIRED per-camera miss-rate panel; actual 6E is
    IDF1-by-difficulty (fig6e_idf1_by_difficulty.csv). No legend exists for it.
 3. RESULTS Fig 3 quality = retired capped shipped pass (4,572,172/1,052/1,309/
    642/449/192). Current: 4,591,725 scored; fresh 940 (2.05/10k) vs exhaustive
    1,453 (3.16/10k); 672 disagreements, GT 592/79; shipped-full 1,077 (2.35/10k),
    809, 592/216.
 4. RESULTS "69 per cent eligible" -> 4,591,864/9,678,503 = 47.4%.
 5. RESULTS 94.6% / 99.000% -> current 94.2% (4,324,469/4,591,864) and 99.038%
    (18,951/19,135).
 6. RESULTS Fig 3 sweep = superseded 8-session grid (569/9.7/3.8 per 100k,
    7,205,370 cf). Current 50-session: fresh r=0 632/100k; r=6 413 switches,
    IDF1 0.8613; shipped r=6 2,071/0.7493; denom 45,021,960.
 7. RESULTS Fig 7 pooled 0.075 / >=2-animal 0.024 "does not clear" -> current
    +0.091 (55/74, P=3.4e-5) and +0.052 (30/42, P=0.008 — it clears).
 8. RESULTS fragmentations "mean 24, Figure 7G" -> current +6.2 (CI +3.0..+10.4,
    median +1.3), panel 7F. "72 of 74" holds.
 9. RESULTS bedding paragraph asserts the claim METHODS retracts; panel cut from
    artwork 2026-08-13. Delete.
10. RESULTS Fig 2D "15 deg ~12 mm; 30 deg under 3 mm" -> deposit: 12.6 mm at
    13.46 deg; ~15 deg pairs give 5.2/4.5 mm; 30.29 deg = 3.34 mm; under 3 only
    at 31.49 (2.68). Legend's "12.6 at 13, 2.7 at 31" is right.
11. RESULTS Fig 5A "two noses 93–106 px apart" -> that span is the TAIL-BASE
    gap; nose gaps are 2.7–6.0 px in that frame. Wrong keypoint under a
    projective-ambiguity argument.
12. METHODS "Figure 4B on 55,298,204 solves" -> retired stride-240; current
    fig4_by_views.json = 884,697,424 (legend right).
13. METHODS smoothing-disable rationale "sampled every 60th frame, >1 s apart"
    -> current pass stride 15/within-session 1 = 0.1 s apart. (Conclusion holds:
    50/50 sessions.)
14. METHODS "0.45 us per keypoint (aniposelib undistortion)" -> no deposit has
    0.45; current 0.573 (ours 1.16).
MAJORS:
15. RESULTS panel letters systematically stale (fig3 C/D/E/F -> B/C/D/E; fig7
    D->C, G->F; 7B bedding gone).
16. METHODS/RESULTS "median cosine 0.004 at two cameras" -> no deposit; only
    deposited move-geometry stat is mean cos 0.066 at k=5, median move 1.249 mm.
17. METHODS RANSAC "2,339 us = 83x" -> stride-60 pass; current 2,466.6 us = 85x.
18. METHODS sampling paragraph quotes stride-200 counts (12.77M/38.32M) as Fig 2
    while claiming every-frame; current 286,200,174 kp / 8.59G held-out. The
    three-session every-20th density check has NO deposit (stride-240-vs-200
    agreement claim does verify).
19. METHODS/RESULTS body-size control "8 sessions / 81 of 103" -> no deposit;
    reconstruction from fig5_upright.json gives 3 sessions / 97 / 75.
    (Rearing-rate control verifies: r=-0.0116.)
20. METHODS promises Holm-corrected counts; none published anywhere.
21. LEGEND-fig10 merge distances 3.0/5.9 mm vs panel_10f_merge.json 1.74/3.89 —
    NOW RESOLVED by the repair agent's swapdiag deposits (2.96/5.87 at-swap
    measured under scored seeds); cite results/agg/swapdiag/.
22. LEGEND-fig10 bout counts previously undeposited — NOW deposited
    (contact_bouts.json): bedding 78.0, triads 177.2, soc1 159.6, soc3 129.9;
    band must widen to ~130–177.
23. LEGEND-fig10 "at sigma 3 the gap widens further" -> only TRIADS widens;
    SCN2A narrows; BEDDING flat. Scope it.
MINORS:
24. fig10 (f) "TRIADS/BEDDING <1 per 100k at every k" -> TRIADS k=3 is 1.11.
25. fig10 (f) "falling monotonically" -> SCN2A rises at k=4, BEDDING at k=6.
26. fig10 (g) "6–8 at 50%" -> 5.60/6.85/7.56.
27. fig10 (e) "~25 min close contact" -> 68,560/50/60 = 22.9 min.
28. fig10 (b) "~1e-13 px on every camera" -> soc1/soc3 cameras at ~3.4e-11
    (still machine precision); "~2,268 px focal" undeposited.
29. LEGENDS 1E date "4 August" -> CHECK_DATE 2026-08-05.
30. LEGENDS Fig 2 S1 "+0.056" -> 0.0552 -> "+0.055".
31. RESULTS 4.27 (every-frame out/fig2.json) vs LEGENDS 4.32 (stride-200 panel
    estimator) — both traceable; scope each so they don't read as the same
    quantity.
32. RESULTS "one or two frames at 30 fps" -> 11 frames (0.373 s).
33. LEGENDS "10^6-fold" cost gap -> 8.1e5; RESULTS' "about a million" safer.
34. RESULTS "per-camera trackers lose half to three quarters" -> 77%.
35. PANEL-SOURCES.md: fig3 panel c listed MISSING though deposit exists; fig2c
    lists the retired --cdf CSV name instead of fig2c_heldout_by_cameras.csv.

Everything else verified to the digit (full pass lists in the agent transcript:
tasks/ae51534133e180dac.output).
