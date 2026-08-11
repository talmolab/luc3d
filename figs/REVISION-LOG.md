# Revision log

What changed in response to the referee report in `REVIEW-REVIEWER2.md`, with the
before and after value of every number that moved. Written so that a response-to-
reviewers letter can be assembled from it, and so that no measurement has to be
reconstructed from memory later.

Status key: DONE, IN PROGRESS, or NOT DONE with the reason.

---

## 1. SLAP-2M is 74 sessions, not 84 (DONE)

`fig6_measure.py` established the corpus by walking the directory tree, which finds 84
session directories, of which 74 carry 3D. The corpus is defined by the master sheet
(`/root/talmolab-smb/eric/slap_2m/master_sheet.xlsx`), which has exactly 74 rows.
`scan_slap()` now joins on that sheet, keying on `session_path` (`<date>/<session>`),
and warns if a sheet row has no directory so it cannot under-count either. The bench
environment has pandas but not openpyxl, so the sheet is read with a dependency-free
zipfile and ElementTree reader.

| | before | after |
|---|---|---|
| SLAP-2M sessions with 3D | 74 of 84 | 74 of 74 |
| Total row, Fig 6E | 130 of 140 | 130 of 130 |

BMimica is unchanged at 56 of 56. Frame and hour totals did not move: they were already
summed over the 74 sessions that carry 3D.

**Latent bug found on the way.** `fig6_pose.py` writes `mean_pose` and `examples_3d`
into the same `out/fig6.json` that `fig6_measure.py` owns, so re-running the measurement
would have silently deleted them and broken Fig 6B and Fig 6E a build or two later, with
no obvious cause. `fig6_measure.py` now preserves keys it does not own.

## 2. Figure 6 measured on every frame (DONE)

Was every 120th frame. The measurement gained a `--jobs` flag (module-level worker,
process pool, results re-sorted by session index) and stride 1 is now the default. The
full 74-session run at 12 workers takes 79 s wall clock, so the subsampling was never
buying anything. Parallel and serial outputs were verified byte-identical.

| quantity | stride 120 | every frame |
|---|---|---|
| keypoint comparisons | 1,561,915 | 187,134,382 |
| miss rate, difficulty 1 to 7 | 10.90x (5.31 to 57.90%) | 10.81x (5.34 to 57.70%) |
| error mean of present keypoints | 1.29x (3.67 to 4.72 px) | 1.30x (3.65 to 4.74 px) |
| fraction beyond 20 px | 5.34x (0.34 to 1.83%) | 5.72x (0.33 to 1.90%) |
| error p50 | 1.11x (2.889 to 3.193) | 1.11x (2.883 to 3.199) |
| error p95 | 1.40x (9.00 to 12.60) | 1.42x (8.95 to 12.71) |
| error p99 | 1.88x (14.52 to 27.36) | 1.92x (14.45 to 27.77) |
| pooled miss by animal count | 12.40 / 33.19 / 45.02 / 39.64% | 12.27 / 33.16 / 44.36 / 39.48% |

Per-stratum session counts are unchanged (12, 13, 9, 13, 10, 4, 13). Per-stratum
keypoints rose from 252,265 / 342,287 / 229,072 / 245,731 / 273,748 / 91,922 / 126,890
to 30,199,536 / 40,786,166 / 27,668,941 / 29,355,207 / 32,791,049 / 11,091,948 /
15,241,535. The mean-based fold changes moved by under 1 per cent; the tail statistics
moved most, which is what tail statistics do when the sample grows 120-fold, and is the
reason the run was worth doing.

`panels/fig5_03_capture.py` reads the same deposit and was rebuilt for consistency;
nothing on that artwork changed (capture at a 10 per cent budget: residual 26.95 to
26.95, confidence 11.72 to 11.76, oracle 31.82 to 31.91).

## 3. Rates instead of raw totals (DONE)

A total is uninterpretable without its denominator, and the referee objected that counts
were being compared across configurations whose frame counts differ by three orders of
magnitude.

**Figure 3D** now plots misgrouped frames per 10,000 clean frames. Percentages were
rejected because every value is below 0.9 per cent and the two headline totals would
carry four leading zeros. The raw count is still printed beside each marker.

| configuration | clean frames | exhaustive | LUC3D |
|---|---|---|---|
| 2 animals x 5 cameras | 122,830 | 0 (0.00 per 10,000) | 0 (0.00) |
| 2 x 6 | 14,275 | 1 (0.70) | 1 (0.70) |
| 3 x 5 | 200 | 0 (0.00) | 0 (0.00) |
| 4 x 3 | 366 | 3 (81.97) | 0 (0.00) |

The rate axis is what makes the 4 x 3 result legible: as counts, 3 and 1 sit next to
each other; as rates they are two orders of magnitude apart. Pooled: LUC3D 1 of 137,671
(0.07 per 10,000), exhaustive 4 (0.29 per 10,000).

**Figure 3E** now plots identity switches per 1,000 camera-frames. The denominator was
not in the deposit and was added: **7,205,370 camera-frames**, reproduced per camera and
session from the same `min(gt_frames, det_frames)` rule the scorer uses, read from HDF5
shapes only. A new `python3 figs/fig3_sweep.py --denominators` mode re-measures only the
frame counts and merges them into the existing JSON; no tracker run and no re-scoring.
The panel exits rather than drawing if the key is absent, so the rate cannot silently
revert to an assumed denominator.

| weight ratio r | switches | per 1,000 camera-frames |
|---|---|---|
| 0 | 40,984 | 5.688 |
| 0.5 | 1,548 | 0.2148 |
| 1 | 696 | 0.0966 |
| 2 | 418 | 0.0580 |
| 6 (shipped) | 324 | 0.0450 |
| 12 | 272 | 0.0377 |
| 24 | 272 | 0.0377 |

**Figure 7E** already reported percentages of camera-frames (denominator 11,726,640) and
was left alone.

Stale numbers in the Fig 3E docstring were corrected while there: it claimed 1,329
switches at r = 0 falling to 2, with the floor at r = 2, which came from the retired
6,000-frame windowed run. The full-session deposit says 40,984 falling to 272 with the
floor at r = 12.

## 4. Animal numbers reported (DONE)

The referee noted, correctly, that the number of animals appeared nowhere. Measured from
the recordings rather than assumed:

- **BMimica: 9 individual mice in 18 distinct pairings across 56 sessions.** A reader
  would otherwise infer roughly 112 animals from "56 sessions, two mice each". Each pair
  contributes between one and six sessions, so sessions are repeated measures.
- **SLAP-2M: 126 animal-sessions** (32 sessions with one animal, 35 with two, 4 with
  three, 3 with four; 46 white, 42 agouti, 38 black by coat). **The 3D files carry no
  animal identities**, so the number of distinct mice cannot be recovered from the data.
  This needs to come from lab records before submission. Methods currently says so
  explicitly rather than guessing.
- **HardFight: 3 mice, one session.**

Difficulty strata are 12, 13, 9, 13, 10, 4 and 13 sessions for ratings 1 to 7; bedding is
44 black and 30 white.

## 5. Figure 5 replicated at the pair level (DONE)

The referee's pseudo-replication objection is real: 37 sessions are not 37 independent
pairs. Repeating the leader analysis with the pair as the unit of replication:

| statistic | session level | pair level |
|---|---|---|
| units with 5 or more displays | 24 sessions | 14 pairs |
| displays covered | 510 | 536 |
| median leader share | 0.83 (IQR 0.73 to 0.89) | 0.81 (IQR 0.74 to 0.91) |
| same member leads | 16 of 24 clear the null | 14 of 14 pairs |
| test | Wilcoxon vs 0.5, P = 9 x 10^-6 | sign test P = 1.2 x 10^-4; Wilcoxon P = 9.7 x 10^-4 |
| pooled leader share | 432 of 539, 80.1% | 429 of 536, 80.0% |

The result survives, and to the same value. Eight of the 14 pairs are individually above
chance by a two-sided binomial test. Figure 5 therefore stays, as the user asked, and the
pair-level analysis is reported in Methods, Results and the Fig 5 legend.

## 6. Statistics added where only fractions were given (DONE)

The three controls on the initiator asymmetry now carry tests:

- initiation share against share of rearing time: Pearson r = -0.012, P = 0.96; Spearman
  rho = 0.044, P = 0.84; n = 24 sessions.
- shared height threshold returns the same leader in 22 of 24 sessions; an absolute
  60 mm threshold in all 24.
- body size: in the 8 sessions where the initiator is the longer animal it still starts
  81 of 103 displays, 79 per cent, binomial against 0.5 P = 4.1 x 10^-9.

## 7. Wording and framing corrections (DONE)

- Figure 2C's reference is the detector's output in the held-out view, not a human label.
  Results now says so, and says the annotator question is untested.
- Figure 7A's cross-view result is marked as partly definitional and explicitly not
  presented as a benchmark win.
- The Anipose smoothing choice is reframed as a rule fixed before the results were seen,
  rather than "the panels draw the more favourable one".
- The timing comparison is flagged as two implementations across two language runtimes,
  with the browser constraint given as the reason the shipped solver is the one measured.
- The SLAP-2M coupling null (1.08x within two body lengths, 0.97x beyond) was promoted
  from Methods into Results.
- A closing section, "What these results do and do not establish", covers the scope
  (mice, two rigs, one skeleton), the two results that differ between corpora, and the
  three comparisons that rest on thinner samples than their absolute numbers suggest.
- Figure 6E lost its "Measured in c, d, f" row on the user's instruction; the
  qualification it carried, that the 130-session total is a composition statement and not
  the n behind any panel, moved into the Fig 6 legend.

## 8. Full-data reruns still in flight (IN PROGRESS)

- **Figure 2** re-measured at every frame across all 50 sessions.
- **Figure 4** at the highest achievable density, with the arithmetic recorded for any
  arm that cannot be run at every frame. The aniposelib `optim_points` arm is the one at
  risk, since it is a single global least-squares per session and both its time and its
  memory grow with points per session.
- **Figure 3** head-to-head extended past one session per configuration.

Numbers from these will be appended here and propagated to METHODS, RESULTS and
FIGURE-LEGENDS in one pass.

## 9. Referee items that are the manuscript's to fix, not these files (NOT DONE)

These are in the submitted PDF rather than in `figs/`, and none of them can be fixed
from this repository:

- The **Discussion is an empty heading**.
- There is **no reference list**, and the text cites three works while comparing against
  Label3D, JARVIS, DeepLabCut, Anipose, DANNCE and SDANNCE, Lightning Pose, ByteTrack,
  3D-MuPPET, motmetrics and the IDF1 metric.
- No **data availability** statement, repository, accession or licence, although the
  abstract presents the datasets as a contribution.
- No **code availability** statement, version or commit identifier.
- No **ethics statement** naming the protocols and institutions under which the original
  recordings were acquired.
- No **author contributions, competing interests or funding** statements.
- The abstract's **"BMimica-11M"** does not match the 10,084,734 frames in Methods, and
  that name appears nowhere else in the paper.
- The abstract claims a **"novel cross-view ReID tracking algorithm"**; the Methods
  describe standard multi-view association machinery, and the contribution is better
  framed as the interactive browser-resident implementation.
- The manuscript **dropped the lead sentences** from the Fig 2, 3 and 4 legends when the
  legends were pasted in; they are present in `FIGURE-LEGENDS.md`.
- Figure 7 is headed **"Supplemental"** in the manuscript but is a main figure, and
  Figure 6 is headed "datasets" although its panels are about detection quality.
- **No annotator study.** The 2.3-fold labelling saving is a model, not a measurement.
  This is the referee's single most substantive request and the one that needs new work
  rather than better reporting.
