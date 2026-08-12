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

The rate axis is what makes the configurations comparable at all: their denominators
differ by three orders of magnitude, so equal counts are wildly unequal rates. The
values that motivated the change are superseded by the corpus-scale re-run in section 8
below; see that table for the current ones.

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

## 8. Figure 3 head-to-head, 4 sessions to 92 (DONE)

The referee's principal objection was that the central benchmark was four recordings,
one per configuration, with 89 per cent of its frames from a single two-mouse session
and the whole multi-animal case resting on 566 frames. Re-run across every session that
has both pool detections and proofread ground truth:

| configuration | sessions before | after | frames computed before | after |
|---|---|---|---|---|
| 2 animals x 5 cameras | 1 | 50 | 122,830 | 4,324,469 |
| 2 x 6 | 1 | 35 | 14,275 | 237,841 |
| 3 x 5 | 1 | 4 | 200 | 7,001 |
| 4 x 3 | 1 | 3 | 366 | 3,000 |
| 4 x 6 | 0 | 0 of 3 available | 0 | 0, still not run |
| total | 4 | 92 | 137,671 | 4,572,311 |

Frames considered rose from 201,092 to 9,678,503 and eligible from 137,671 to
4,591,864. The binding constraint was never the corpora: it is which sessions have both
detections and ground truth, which is 50 of 56 BMimica and all 74 SLAP-2M.

**Agreement fell from 99.99637 to 99.98596 per cent**, and the more useful result is
that it now degrades monotonically with animal count, which four sessions could not
show: 99.996 per cent at 2 x 5, 99.814 at 2 x 6, 99.829 at 3 x 5, 99.000 at 4 x 3.

**Misgrouping against ground truth** went from 1 frame (LUC3D) and 4 (exhaustive) to
**1,052 and 1,309** over 4,572,172 clean frames, that is 2.30 and 2.86 per 10,000. The
qualitative result strengthens: on the 642 frames where the methods disagree, ground
truth sides with greedy on 449 and with exhaustive on 192. That claim rested on 5 events
and now rests on 642.

Per-frame exhaustive timings moved: 0.0115 s at 2 x 5 (was 0.0081), 0.0159 at 2 x 6,
3.356 at 3 x 5 (was 3.85), 6.951 at 4 x 3 (was 7.82). Re-derived from those rates, the
unrun 4 x 6 bound moves from 0.5 to 18 hours per frame to **0.55 to 26.7 hours**.

Frame caps apply only to the two expensive configurations, 2,000 eligible frames per
session at 3 x 5 and 1,000 at 4 x 3, because uncapped 4 x 3 alone would have been 37
core-hours. A new `--clean-sample` scans the whole session for eligibility, so the
considered and eligible counts stay honest full-session numbers, then enumerates a
uniform sample across the session rather than a head-of-session prefix. It is verified
bit-identical to the old driver when the cap does not bind.

Total exhaustive compute: 27.1 core-hours, about 4 hours end to end.

**Panel 3D had to be rebuilt for the new numbers.** Counts went from 0/1/3 to three and
four digits and the layout collided in five places. It is now a log rate axis, which
also makes the animal-count trend legible, with the raw count above each marker, the
per-configuration n under each tick, and the pooled totals moved to the legend where
they no longer have to fit in 57 mm.

**Do not cite the IDF1 in this deposit.** Greedy 0.791 against exhaustive 0.378 is
harness artefact twice over: the disclosed identity threading, plus the fact that
exhaustive is scored only on the frames it computed while greedy is scored on whole
sessions. Both are recorded in the deposit's caveats and no panel plots it.

## 9. Figure 2 measured on every frame, and on 6 more sessions (DONE)

Started here, stopped at 25 of 50 when it was holding 138.6 GB, handed to another
machine (`HANDOFF-FIG2.md`) and completed there.

| | stride 200 | every frame |
|---|---|---|
| sessions | 50 | **56** |
| frames used | 45,053 | 10,084,734 |
| keypoints | 1,277,424 | **286,200,174** |
| held-out median, own detection | 4.32 px | 4.27 px |
| at or below 5 px | 59.90% | 60.7% |
| at or below 10 px | 94.59% | 94.55% |
| at or below 20 px | 99.68% | 99.64% |
| outside the 10 px tolerance | 5.41% | 5.45% |
| placements at C = 5, tau = 10 px | 32.43 | 32.45 |
| saving at C = 5 | 2.31x | 2.31x |

Two things worth noting. The sample grew **224-fold** and not one headline moved by more
than a tenth of a pixel or a tenth of a percentage point, which is the direct answer to
the referee's sampling objection: the 0.5 per cent sample was unbiased. And the corpus
grew from 50 sessions to **56**: the six sessions that were skipped at stride 200 for
having too little cross-camera overlap have enough of it once every frame is used, so
the figure now covers every BMimica session rather than 50 of 56.

## 10. Figure 4 at four times the density, and why not more (DONE)

Every secondary subsample removed and the export stride taken from 60 to 15.

| arm | before | after |
|---|---|---|
| keypoints | 4,253,636 | 17,013,412 |
| panel B solves | 55,298,204 | 884,697,424 |
| panel B sampling | export 60 then every 4th keypoint | export 15, every keypoint |
| held-out-by-views | every 3rd keypoint | every keypoint |
| worst-camera n per stratum | 1,167,554 / 3,019,181 / 66,901 | 4,671,933 / 12,073,053 / 268,426 |

**Nothing moved.** Every median shifted by under 1 per cent and both head-to-head win
counts are unchanged: aniposelib's linear solve still beats ours in 50 of 50 sessions
out of sample and beats our refinement in 49 of 50. Held-out error at 2, 3 and 4 cameras
is 4.32, 3.66, 3.34 px for the DLT and 4.42, 3.54, 3.15 for the refinement.

**One number did move, for a real reason.** aniposelib's optim_points went from 122.1 to
228.8 microseconds per keypoint, because it is one global least-squares per session and
the cost sweep now reaches the true session size of about 23,000 frames rather than
stopping at 4,000. The speed ratios are therefore 4.6x on the linear pair and 5.2x on
the non-linear pair, not 4.4x and 2.8x. RANSAC moved 2,339 to 2,467.

**Full frames is ruled out by measurement, not by assertion.** optim_points was profiled
at five densities on a real session: memory is linear at about 14 GB per million points,
so stride 1 needs roughly 75 GB and 17 minutes for a single solve, times 18 solves per
session, which is about 200 CPU-hours and some 33 hours of wall clock at the six workers
that fit in 500 GB. Every 15th frame is the densest setting at which the slowest arm
fits, and all four solvers share it because panel D compares them on the same keypoints.

**Panel E's timings were nearly wrong.** The agent's own 12 concurrent processes inflated
them to 7.67 and 64.35 microseconds per keypoint, since fig4_measure accumulates timing
inside its sweep. Re-run alone it gives 6.32 and 44.00, with every accuracy field
bit-identical. The contaminated run is kept at `out/fig4.stride15-timing-underload.json`.
A timing benchmark taken on a loaded machine measures the machine.

**Panel D was reduced to the all-cameras arm on request**, with the win counts and the
group label removed and everything enlarged. The held-out arm is still deposited and is
quoted in the legend; the y label now names the scoring space, because the arm that
remains is the one our refinement minimises by construction.

## 11. Full-data reruns: all complete

Figures 2 and 6 at every frame, Figure 4 at the densest setting its slowest arm allows,
Figure 3 across every session that has detections and ground truth. None outstanding.

- **Figure 4** at the highest achievable density. Still running.

Numbers from these will be appended here and propagated to METHODS, RESULTS and
FIGURE-LEGENDS in one pass.

## 12. Referee items that are the manuscript's to fix, not these files (NOT DONE)

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
