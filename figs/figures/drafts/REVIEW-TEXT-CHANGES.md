# Review response, text batch: attribution, tracker framing, calibration ordering, Fig 2C reference

**Date:** 2026-09-20
**File:** `figs/figures/drafts/latex_newest.tex`
**Responds to:** Reviewer 1 majors 2, 3 and 4 and the IDF1 minor, Reviewer 2 majors 1 and 5, in
`AI-REVIEW-NatNeuro.md`, plus the request to present the SLEAP and ByteTrack comparison as a
capability demonstration and not a benchmark win.

Line numbers refer to `latex_newest.tex` after the edits. No figure changed in this batch. The Figure 4
changes of the same day are in `FIG4-REPLICATION-CHANGES.md`.

---

## 1. Greedy versus exhaustive: credit the 3D term (R1 major 4, R1 major 2)

The caption and Discussion credited the greedy search for matching exhaustive enumeration. The r = 0
ablation in Results shows that greedy search alone falls behind exhaustive enumeration and that the 3D
correspondence term is what closes the gap. The comparison with Maree et al. as published is unchanged.
The method does outperform exhaustive enumeration on the frames both score (926 misgrouped frames to
1,309, and 0.92 switches per 100,000 camera frames at IDF1 0.861 to 81 per 100,000 at 0.628), so
"outperforms" stays. The wording now attributes that result to the method with its 3D term, and scopes
it to the frames where enumeration can be run.

- **L140** Subsection title: "A greedy per-camera assignment outperforms exhaustive approaches and
  enables fast tracking" changed to "A greedy per-camera assignment with a 3D correspondence term
  outperforms exhaustive enumeration at a fraction of the cost".
- **L148** After "All non-zero ratios result in the greedy approach outperforming exhaustive", one
  sentence added: the 3D term is what lets the greedy search outperform exhaustive enumeration, since
  without it the greedy search alone falls behind.
- **L159** (Figure 3 legend, first sentence) "Greedy per-camera assignment groups as accurately as
  exhaustive enumeration at lower cost" changed to "Greedy per-camera assignment with a 3D
  correspondence term groups more frames correctly than exhaustive enumeration at a fraction of the
  cost, on the frames where enumeration can be run."
- **L205** (Discussion) "The results show that greedy Hungarian matching is faster and groups more
  frames correctly than the exhaustive strategy" replaced with two sentences: the comparison is on the
  frames where exhaustive enumeration can be run, which excludes frames with a missed or duplicated
  detection, greedy matching with the 3D term misgroups fewer frames and runs about 30 times faster,
  and the ablation shows the 3D term is what makes the greedy search competitive.

## 2. IDF1 definition (R1 minor)

- **L148** The author's definition is kept as written ("IDF1 is an accuracy metric that explains the
  proportion of true positive tracks over all tracks, including true positives, false positives, and
  false negatives"), with a citation to Ristani et al. 2016 added. The review's "that is not IDF1" was
  too strong: the sentence describes the formula correctly. Two optional precisions if a referee asks:
  the counts are over identity-matched detections, not tracks, and the matching between ground-truth
  and predicted identities is one-to-one over the whole sequence, which is why a switch costs every
  frame after it.
- **L508** New `\bibitem{Ristani2016}`, placed between Pereira and Waldmann.

## 3. SLEAP and ByteTrack: capability demonstration, not a benchmark (R1 major 3 and the author's request)

The cross-view comparison is now framed as a capability demonstration everywhere it appears, and the
seven-session result in which SLEAP is ahead has moved into the main text. The within-view comparison
is a separate measurement and its result stands: LUC3D's within-view IDF1 is higher in 56 of 74
SLAP-2M sessions (+0.099 pooled, +0.067 in multi-animal sessions), with the seven three- and
four-animal sessions the exception. The text says so in the same sentences that state the exception.

- **L150** (main text, end of the cross-view subsection) New paragraph after the pointer to the
  supplement. States that SLEAP and ByteTrack track each camera on its own, that 1/C is a ceiling on
  their cross-view IDF1, that the comparison demonstrates a capability and is not a benchmark of the
  three trackers, that within a camera the three methods are broadly competitive, that LUC3D's
  within-view IDF1 is higher in 56 of 74 SLAP-2M sessions (pooled difference 0.099, sign test P =
  1.1e-5) and SLEAP's is higher in every one of the seven sessions with
  three or four animals, and why (those are the sessions with the most occlusion, where the 3D targets
  that link identity across views are most often missing).
- **L392** Supplementary subsection title "Cross-view identity tracking: parity within cameras, gains
  across them" changed to "Cross-view identity tracking compared with per-camera trackers".
- **L394** Two sentences added at the end of the opening paragraph: the trackers were not designed to
  keep identity across cameras, the cross-view comparison demonstrates that capability and is not a
  benchmark, and the within-view comparison is there to show that cross-view association does not cost
  within-view accuracy and in most sessions improves it.
- **L396** "all three methods are broadly competitive, and LUC3D's advantage over SLEAP is largest in
  the single-animal sessions" changed to "all three methods are broadly competitive. The within-view
  difference between LUC3D and SLEAP is largest in the single-animal sessions". Both instances of "in
  LUC3D's favor" replaced by "LUC3D's within-view IDF1 is higher by 0.099" and "the difference is 0.067",
  the counts and P values kept. "SLEAP is slightly ahead in all seven sessions" kept as written.
- **L398** After "The comparison therefore scores SLEAP and ByteTrack on a capability they never
  claimed", two sentences added: it shows the capability is present in LUC3D and absent in per-camera
  trackers, and tracking quality within a camera is the separate measurement of Figure 6B and C, where
  LUC3D is higher in 56 of 74 sessions and SLEAP in the seven sessions with three or four animals. The
  garbled
  duplicate sentence "This comparison establishes is that ... LUC3D also improves ..." deleted
  (copydesk #255 and #169).

Left as they were: the Figure 6 legend (numbers only), the Methods description of the baseline
settings at L344 to L348, and the Discussion paragraph on proofreading labor at L209, none of which
claims a win over the trackers.

## 4. Calibration: held-out rig first (R2 major 1)

- **L417** "On the 18-camera dataset it is 0.21 pixels and Anipose 1.28, on the SLAP-2M rig 0.10 and
  0.32, and on the held-out Mouse-Dyad-10M rig 0.07 and 0.09" reordered: the held-out Mouse-Dyad-10M rig,
  which had no part in choosing calibrat3's defaults, is stated first (0.07 and 0.09), then the two rigs
  used to choose the defaults with their larger margins (0.10 and 0.32, 0.21 and 1.28). The headline
  sentence "lower on all three rigs" is unchanged.

## 5. Figure 2C reference (R2 major 5)

`panels/fig2_03_reprojection_accuracy.py` confirms that panel C measures the 3D distance between the
k-view solve and the proofread reconstruction, and the proofread reconstruction was itself solved from
all five views before hand correction. The five-camera value therefore measures the size of the
proofreading corrections and is not an independent accuracy. The text said neither.

- **L129** "A 3D point solved from two views and projected into a view that was not labeled has a
  median 4.74~mm error" corrected, since the panel is a 3D distance and involves no projection. Now: a
  two-view solve is a median 4.74 mm from the reference and the five-view solve 1.19 mm. The reference is
  described as the proofread reconstruction solved from all five views and corrected by hand, the
  five-camera value as the size of those corrections, the smaller-k values as relative to it, and Figure
  2E is named as the out-of-sample measurement.
- **L136** (Figure 2 legend, C) "3D error by the cameras count included in the solve" changed to "3D
  distance from the proofread all-view reconstruction by the number of cameras in the solve", with two
  sentences added: the five-camera value is the size of the proofreading corrections, and E gives the
  out-of-sample error.

## 6. Verification

- Every replacement was applied with an exact-match assertion on the previous text (one occurrence).
- The edited lines (129, 136, 140, 148, 150, 159, 205, 392, 394, 396, 398, 417, 508) were checked for
  "against" as a comparison, "rather than", "in LUC3D's favor", "advantage over" and "outperform". The
  one remaining "outperforming" at L148 is the pre-existing sentence about the greedy versus exhaustive
  ratio sweep and is not a tracker claim.
- `grep -c "establishes is"` returns 0.

## 7. Still open from the review

- **R1 major 1** Held-out split for the tracker hyperparameters on SLAP-2M. Analysis work, not text.
- **R1 major 5** End-to-end evaluation conditional on the detector. Analysis work.
- **R1 major 6** Validation of the Maree et al. reimplementation. Needs the original code or numbers.
- **R2 majors 2, 3, 6** Physical scale check, native-convention aniposelib numbers, annotator study.
- **R3 majors 5, 6** Behavioral context and positioning in the rearing literature. Author text.
- **Panel titles** on Figure 4 D and E still state conclusions.
