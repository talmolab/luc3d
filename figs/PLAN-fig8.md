# Figure 8 — LUC3D against the state of the art

**Status:** plan. No panel written, no data deposited.
**Date:** 2026-08-08
**Targets:** Lightning Pose / Lightning Pose 3D (Paninski lab) and social-DANNCE (Dunn/Ölveczky).
**Companion:** `/root/vast/eric/luc3d-bench/plans/2026-08-03-social-dannce-benchmark-plan.md`
— that document's §0 framing finding is still correct and is promoted here to a panel;
its §2 "calibration unconfirmed" risk is **resolved** (see §3 below) and its Phase 2/3
sizing is **wrong by an order of magnitude** for the same reason.

---

## 0. The problem this figure has to solve

Figures 3, 4 and 7 already compare LUC3D against SLEAP and ByteTrack, which are
*trackers*. The two systems a Nature Neuroscience reviewer will actually name are
Lightning Pose and social-DANNCE, and **neither is a tracker**. They solve adjacent
problems with far more compute, and neither reports a single metric that Fig 7 reports.
So the figure cannot be "LUC3D wins" — there is no shared scoreboard to win on. It has
to do three things in order:

1. **Say where each system spends its modelling budget**, so the reader can see the
   comparison is between neighbours, not rivals — and that the cross-view identity stage
   LUC3D exists for is *absent* from both.
2. **Find the one thing that genuinely is shared — triangulation — and run it head to
   head on identical 2D and identical calibration**, on our data and on theirs.
3. **Take LUC3D onto their data and score the thing they do not measure**, so the
   positioning claim in (1) is backed by a number rather than by a reading of their code.

Anything beyond those three is optional. Anything that looks like "we beat a network we
trained ourselves for 24 epochs" is a liability — see §1.

---

## 1. What already exists in `luc3d-bench`, and why one piece of it must not be published

**Already built and run (May 19):** a full Lightning Pose → LUC3D *detector-swap*
pipeline. `lp3d_data/` holds SLAP-2M restaged in LP's multiview layout (6 views —
back/backL/mid/midL/top/topL — over 5 sessions, with anipose `calibrations/*.toml`),
`lp3d_models/slap2m_mvt/` holds a multi-view-transformer model trained on it,
`scripts/lp3d/` holds the whole chain (`prepare_lp3d_dataset.py` →
`run_all_inference.sh` → `aggregate_lp3d_h5.py` → `luc3d_track_all.mjs` →
`evaluate.py` → `compare_results.py`), and `outputs/metrics/lp3d_swap/comparison.csv`
holds the result over 10 sessions.

**The result is negative and it is an artefact.** LP-detections score lower than
SLEAP-detections on 10 of 10 sessions (Δ IDF1 −0.003 to −0.468), but the mechanism is
missed detections, not identity: on `10072022184618` the miss count goes 994 → 129,363,
on `10072022175009` 135 → 39,003. Meanwhile `lp3d_models/slap2m_mvt/train_status.json`
still reads `"status": "TRAINING", "completed": 24, "total": 50`.

> **Do not put this in the paper.** Publishing "Lightning Pose detects worse than SLEAP"
> on the strength of a competitor's model that we trained ourselves to 24 of 50 epochs
> on 5 sessions of labels is the single most attackable thing this figure could contain,
> and it is attackable because it is *probably wrong*. Two honest exits: (a) finish the
> training run, re-run inference, and report it only if the detector is competitive; or
> (b) drop the detector-swap axis entirely and keep the figure on triangulation and
> identity, where no third-party training is involved. **Recommendation: (b) for the
> figure, (a) as a supplementary note if the finished model is competitive.** The
> pipeline is written either way, so (a) is cheap to attempt and cheap to abandon.

The corollary shapes everything below: **every Fig 8 comparison must be one where we run
no third-party training.** That is achievable, because the shared surface is
triangulation and both competitors' triangulators are ~50 lines of published code.

---

## 2. Lightning Pose — what is actually comparable

Two papers, and the figure must be clear which it is arguing with:

* **Lightning Pose** (Biderman, Whiteway et al., *Nat Methods* 21:1316–1328, 2024) —
  semi-supervised 2D pose with multi-view *consistency losses*. No calibration, no 3D
  output. This is the paper Eric linked; it is **not** the competitor.
* **Lightning Pose 3D** (Aharon, Lee, Sikka, Chettih, Hurwitz, Paninski, Whiteway;
  arXiv 2510.09903, Oct 2025; bioRxiv 10.64898/2026.04.20.719731, Apr 2026) — multi-view
  transformer + 3D augmentation + triangulation loss + **nonlinear ensemble Kalman
  smoother with variance inflation**. Calibrated, emits 3D. **This is the competitor**,
  and Fig 1d's "multi-view losses" cell is now out of date and must be re-checked
  (`src/tools_table.py`, `CHECK_DATE = 2026-08-05`).

**Which of their code is the 3D path — this determines whether we run their software or
a reimplementation of it, and the answer is the good one.** `lightning_pose` itself
(v2.3.1, 2026-07-21) ships the multi-view *2D* stack — MVT backbone, patch masking, the
3D reprojection loss, 3D augmentation, `lightning_pose/data/cameras.py` — but **no
triangulation module**. Their own docs route 3D to a separate package:
*"Ensemble Kalman Smoother (EKS) for 3D triangulation and smoothing,*
`pip install ensemble-kalman-smoother`*"*. So **EKS-multicam in nonlinear mode IS
Lightning Pose 3D's shipped triangulator**, and we can invoke it exactly as their
documentation instructs rather than reimplementing anything. Internally it calls
**aniposelib** `CameraGroup.triangulate(..., fast=True)` and then smooths with a
state-space model whose observation is the multi-camera projection, inflating ensemble
variance where the Mahalanobis distance across views exceeds a threshold.

The paper *additionally* describes an OpenCV `undistortPoints` + `triangulatePoints`
per-camera-*pair* solve with the **median over all pairs**. Treat that as their
evaluation/baseline triangulation, not the shipped path — it is a ~40-line reimplementation
and it belongs in the panel as a secondary series, clearly labelled as the paper's
described variant rather than as "what a Lightning Pose user gets".

So there are **four triangulators that consume the identical input**:

| # | method | what it minimises | source | status |
|---|---|---|---|---|
| 1 | LUC3D linear DLT | algebraic error, ideal pinhole, closed form | `pose/triangulation.js:triangulatePointDLT` | ours, shipped |
| 2 | LUC3D refined | geometric error in native distorted px, soft-L1 + L1 polish, cameras fixed | `triangulatePointBA` | ours, shipped |
| 3 | **EKS-multicam, nonlinear** | aniposelib DLT over all views + nonlinear EKS w/ variance inflation | `pip install ensemble-kalman-smoother` | **theirs, shipped — run their code** |
| 4 | LP3D pairwise-median | per-pair DLT, median over the C(C,2) pairs | reimplement, ~40 lines OpenCV | theirs, paper-described |

**Pin the version on the artwork.** `lightning-pose` and `ensemble-kalman-smoother` are
both under active release (five lightning-pose releases between 2026-05-15 and
2026-07-21); a triangulation comparison against a moving target has to name the commit
it ran, the way `CLAUDE.md` pins the vendored dependencies.

They all take (2D per view, anipose `.toml`) and return 3D. **LUC3D's SLAP-2M and
BMimica calibrations are already anipose `.toml`** and Lightning Pose's documented
calibration format is anipose `.toml` — so the head-to-head needs **no format work at
all**. This is the cheapest strong panel in the figure and it should be built first.

**Scoring must be reference-free**, because the proofread 3D is not the minimiser of
reprojection error on these detections (Fig 4's "no 3D-accuracy comparison between
solvers is available from this corpus" applies verbatim to methods 3 and 4 as well).
Use the Fig 4d protocol unchanged: solve from *k* of the C views, project into the
held-out view, score against the raw detection there. That protocol is already
implemented and already produces the numbers in Fig 4d.

---

## 3. social-DANNCE — verified feasibility, and the sizing the prior plan got wrong

The prior plan flagged `BEDDING` as "calibration unconfirmed" and routed everything
through `TRIADS` with a hand-annotation phase. **Both of those are now obsolete.** I
pulled the Dataverse file tree and two actual files.

**`BEDDING` (doi:10.7910/DVN/696AK6, 10.5 GB, "social-DANNCE keypoint tracking for rat
dyad movies with bedding") contains six complete dyad sessions**, each with:

```
2024_05_07_F1_F3/
  calibration/hires_cam{1..6}_params.mat     525 B each  — VERIFIED
  videos/Camera{1..6}/0.mp4                  ~130–310 MB each
  videos/Camera{1..6}/frametimes.npy
  SDANNCE/predict00/save_data_AVG0.mat       232 MB — s-DANNCE 3D, both rats, all frames
  SDANNCE/predict00/com3d_used.mat           5 MB
  20240823_193702_RAT1_Label3D_dannce.mat    1.9 MB — HUMAN labels, rat 1  — VERIFIED
  20240823_205507_RAT2_Label3D_dannce.mat    1.9 MB — HUMAN labels, rat 2  — VERIFIED
```

**Calibration** parses cleanly: `K` (3×3, MATLAB row-vector convention, so transposed
relative to ours), `RDistort` (k1,k2), `TDistort` (p1,p2 — zero on this rig), `r` (3×3),
`t` (1×3, mm). Converting to anipose `.toml` is a ~30-line script: transpose `K`,
Rodrigues `r`, pad distortions to `[k1,k2,p1,p2,k3]`.

**The Label3D files are the find.** Each holds `labelData` as one struct **per camera**
with `data_2d` (frames × 46 = 23 keypoints × 2), `data_3d` (frames × 69), `data_frame`,
`data_sampleID`. On the file I opened: **27 frames, 6 cameras, zero NaN**. That is
*human 2D in all six views with the animal's identity named in the filename* — exactly
the input LUC3D's tracker takes, on someone else's rig, species and skeleton, obtained
for **1.9 MB and no GPU**.

**The sizing correction.** The prior plan budgeted 1–2 days of hand-annotating identity
swaps. That is unnecessary but the free ground truth is also *much smaller than it
looks*: RAT1 and RAT2 are labelled on **largely different frames**. In `F1_F3`, RAT1 has
27 sample IDs and RAT2 has 29, and **only 11 are shared**. A two-animal cross-view
association test needs both animals labelled on the same frame, so the human-GT set is
**~11 frames × 4 sessions ≈ 44 frames** (`F1_F3`, `F5_F3`, `F6_F2`, `F6_F3` are the four
with per-rat files; `2024_05_05_F1_F2` and `2024_05_05_F5_F3` have only COM labels).

**44 frames is audit-grade, not panel-grade.** So the panel's n has to come from
projecting s-DANNCE's own 3D predictions (`save_data_AVG0.mat`, both animals, every
frame) into the six cameras, giving identity-labelled 2D at full session length; the 44
human frames then serve as the *audit* of that projected ground truth. Both are in the
figure and the caption must say which is which. This is the single most important design
decision in the sDANNCE half and it is forced by the 11/27 overlap, not chosen.

**What we still cannot do, and should stop trying to:** run s-DANNCE on our data. The
prior plan's §1 is right — the COM stage is a per-cohort N-channel U-Net whose channel
order *is* the identity, so there is no zero-shot path onto BMimica/SLAP-2M, and
retraining it is exactly the liability §1 above warns about. **We bring our tracker to
their data; we do not bring their network to ours.**

---

## 4. The panels

Six panels. **b** and **d** are load-bearing; **a** and **g** are cheap and carry the
framing; **c** and **e** are what stop a reviewer dismissing b and d. **f** is optional
and is the first thing to cut.

### a — Where each pipeline spends its budget *(schematic, `src/diagram.py`)*
The same four-stage bar drawn three times — 2D detection → **cross-view association** →
3D reconstruction → interactive correction — with each system's stages filled in and its
absent stages struck through.
* **LP3D**: stages 1 and 3, heavily; **no stage 2** (single-animal throughout — the
  arXiv paper's datasets are one fly, one mouse, one chickadee); no stage 4.
* **s-DANNCE**: stages 1–3 collapsed into one volumetric CNN + PoseGCN; **stage 2 does
  not exist** because identity is fixed upstream by a human ordering the COM network's
  output channels, and the paper says outright that visually indistinguishable animals
  need "more advanced ID tracking methods"; no stage 4.
* **LUC3D**: light stage 1 (any detector), **stage 2 is the contribution**, stage 3
  classical, **stage 4 is the product**.
No numbers. Every claim traceable to a file in the released repo or a line in the paper,
cited in the panel docstring the way `src/tools_table.py` does it.

### b — Four triangulators, identical 2D, identical calibration, held-out view *(BMimica)*
Methods 1–4 from §2, the Fig 4d protocol, 50 BMimica sessions, 5 cameras. One dot per
session per method, or paired lines; median rule. Reference-free, so no solver is
scored on its own objective. **This panel can be built entirely from data we already
have** — the 2D, the calibrations and the harness are all in place; method 3 is a pip
install of their own package, method 4 is ~40 lines behind the existing evaluator.

**One caveat that shapes how this panel is scored.** EKS is an *ensemble* method: it
wants several seeds per camera and it *smooths temporally*, so on our single-seed
detections it is running outside its design envelope, and a per-keypoint held-out
reprojection metric does not reward temporal smoothing at all. Two mitigations, and the
panel needs at least the first: run EKS's triangulation stage with its smoothing
identifiable (report the triangulated-only and smoothed values separately), and let
panel **c** carry the with-ensemble version on their own data. Scoring their smoother on
a metric it does not optimise, without saying so, is the mirror image of the mistake
Fig 4e already calls out about our own refinement being scored on its own objective.

### c — The same four triangulators on Lightning Pose's own data
`paninski-lab/eks` ships `data/fly/` — a 6-view calibrated fly recording with
`calibration.toml` and **three ensemble seeds per camera** (the `rng=0,1,2` CSVs), which
is what EKS is designed to consume and what we cannot fabricate from our single-seed
detections. Running the head-to-head there does two things: it shows the ranking in **b**
is not a property of our rig, and it lets us run EKS *as its authors intend*, with the
ensemble, so nobody can say we crippled it. Same held-out-view metric.
If the LP3D fly/chickadee releases turn out to be publicly downloadable at full size,
prefer those; the EKS demo data is the guaranteed-available fallback.

### d — Cross-view identity on social-DANNCE's rig
LUC3D's tracker on identity-stripped 6-view 2D from the four BEDDING dyad sessions.
Metric: the Fig 7 harness unchanged (within-view IDF1, **cross-view IDF1**, ID switches
per camera-frame). Two 2D sources, drawn side by side and never pooled:
* **projected** — s-DANNCE's `save_data_AVG0.mat` 3D for both rats reprojected into the
  six cameras, full session length. GT identity = s-DANNCE's channel assignment.
* **human** — the ~44 co-labelled Label3D frames. GT identity = the human's.
The human points are the audit: if LUC3D's assignment agrees with the human on the 44
frames where both exist, the projected GT is trustworthy at scale.

### e — Switch rate against 2D quality *(the panel that makes d survive review)*
Projected 2D is geometrically consistent *by construction*, which is the easiest possible
input for a geometric matcher. Do not hide that — measure it. Sweep three degradations of
the projected 2D and plot LUC3D's switch rate against each: isotropic pixel noise σ,
per-detection dropout rate, and per-view occlusion bursts. Mark on the σ axis where the
real detectors sit (BMimica's measured cross-view residual, 2.584 px median, is the
natural marker; Fig 2's held-out reprojection median 4.32 px is the other). This turns
"we used oracle 2D" from an objection into the panel's finding: **how good the 2D has to
be before cross-view association stops working.** It is also the direct answer to the
question as Eric posed it.

### f — 3D agreement on a third-party rig *(optional, cut first)*
On the 44 co-labelled frames: LUC3D's triangulation of the human 2D, against s-DANNCE's
volumetric prediction, against the human 3D, in mm, on the shared subset of the 23-point
`rat23` skeleton. Anchor to s-DANNCE's published 13.20 ± 0.19 mm human-comparison figure
(**taken from the prior plan's reading of the paper — re-verify against the paper before
it goes on artwork**). Weak because the human `data_3d` is Label3D's own triangulation of
the same `data_2d` we would be triangulating, which is near-circular; keep the honest
comparison the *independent* one, LUC3D-from-2D versus s-DANNCE-from-voxels.

### g — What it costs to get 3D out of each system on a new rig
Labelled frames required, GPU-hours to first output, and whether anything must be
retrained when the rig or cohort changes. LUC3D: zero GPU, zero training, browser.
LP3D: MVT training per dataset. s-DANNCE: COM net per cohort **plus** 3D CNN + PoseGCN,
and the authors' own bar for a new setup is 40 epochs of fine-tuning on 111–211 frames.
Every non-LUC3D cell from published docs, `NEEDS_CHECK`-gated like Fig 1d. This is the
panel that states the actual product claim, and it is the only one where LUC3D wins by a
margin that needs no statistics.

---

## 4b. Results measured so far (2026-08-09)

Built and run, so these are no longer proposals. Harness lives in
`luc3d-bench/scripts/fig8/`:

* `luc3d_triangulate_bridge.mjs` — loads the **shipped** `pose/triangulation.js` into a
  node `vm` with app-level imports stripped, exposing the real `triangulatePointDLT` /
  `triangulatePointBA`.
* `sdannce_track.mjs` — loads `pose/{pose-data,cross-view-tracker,triangulation,tracker}.js`
  plus the real `ui/settings.js` and calls **`runCrossViewTracker`**, the function
  `trackAll()` itself calls.
* `compare_triangulators.py` (fly) / `compare_bmimica.py` (BMimica) / `sdannce_prepare.py`
  / `sdannce_score.py`.
* Env `luc3d-bench/eks_env`: `ensemble-kalman-smoother` **4.6.2**, `aniposelib` 0.8.0.

### Panel b — four triangulators, 50 BMimica sessions, held-out view

Identical 2D (the real per-camera detections), identical anipose calibration, Fig 4d's
protocol, every camera held out in turn, **14,762,252 scored keypoints**. Mean over
sessions of the five held-out-camera medians:

| method | mean px | vs aniposelib | sessions won |
|---|---|---|---|
| **aniposelib** (LP3D's shipped triangulator) | **2.946** | — | 40/50 |
| LUC3D refined | 2.957 | **+0.011 px** | 4/50 |
| pairwise-median (the LP3D paper's) | 2.971 | +0.025 px | 6/50 |
| LUC3D DLT | 3.091 | +0.145 px | 0/50 |

**Lightning Pose 3D's triangulator is better than ours by 0.011 px — 0.4%.** It wins most
sessions, and it wins by nothing. Our *refinement* is what closes the gap: plain DLT is
0.145 px behind, and the refinement recovers 93% of that. On LP3D's own fly demo
(3 cameras, 12 keypoints, 500 frames, their 3-seed ensemble, full `eks multicam`
including the nonlinear smoother) it goes the other way — LUC3D refined lower on 2 of 3
held-out cameras, all gaps 0.02–0.31 px.

**Write the panel as the tie it is.** Two corpora, opposite winners, sub-0.03 px
separation between the three good methods. The defensible claim is *"triangulator choice
is not where these systems differ, and the association upstream of it is"* — which is the
claim this paper wants, and it is consistent with Fig 4's own 3%-out-of-sample finding.
Any attempt to squeeze a win out of 0.011 px will be correctly punished.

### RETRACTED: "LUC3D corrects s-DANNCE's identity" (2026-08-09)

An earlier version of this section claimed that where LUC3D's grouping disagrees with
s-DANNCE's channel identity, geometry showed LUC3D right 4.5x more often (185 vs 41), and
read that as evidence that identity-by-construction silently mis-assigns. **Withdrawn.**
Two independent problems:

1. **The adjudication was circular.** It compared the two groupings by reprojection
   residual -- which is LUC3D's own association objective. LUC3D disagrees with the
   channel precisely when it has found a lower-residual grouping, so that test cannot
   establish the channel is wrong. Saying "the channel is free to win" was not a defence:
   the test statistic itself was biased.
2. **The human data does not support the claim.** `handLabeled2D` in the COM Label3D file
   holds the human's ACTUAL clicks (`data_2d` is reprojection-filled and reproduces
   `data_3d` to 0.0000 px, so it is useless here). Matching 698 clicks to the network's
   detections (median 9.03 px) and asking whether any output channel maps to *different*
   animals in different cameras: **0 conflicts in 113 frames**
   (`scripts/fig8/triads_channel_audit.py`). No geometry, no LUC3D in the measurement.
   Caveat that cuts both ways -- those 113 frames are the COM net's own TRAINING labels,
   so the detector is at its best there; it is an optimistic subset, not proof the channel
   is right everywhere.

**Re-run non-circularly** (leave-one-camera-out: triangulate each identity from its other
cameras and predict the held-out one -- Fig 4d's protocol, a quantity neither method
optimises), on the same 287 disagreement frames:

| | frames | share |
|---|---|---|
| LUC3D predicts the held-out view better (>1 px) | 194 | 68% |
| channel better | 47 | 16% |
| tie (<=1 px) | 46 | 16% |

median margin **+3.26 px** to LUC3D. But the MEAN margin is **-27 px**, and that sign flip
is the whole story: the distribution has heavy tails on both sides driven by a handful of
near-degenerate frames (p1 -145 px, p99 +895 px, worst single frame -21,066 px, 3 frames
where the channel wins by >200 px). **Quote the median and the counts; the mean is
meaningless here.**

**What panel d can honestly claim, and what it cannot.** It CAN say the two methods agree
on 90% of frames, and that on the 10% where they disagree LUC3D predicts a held-out camera
better about four times as often as it predicts worse. It CANNOT say s-DANNCE is wrong 10%
of the time -- that was never measured, the human audit finds no channel errors at all, and
"disagreement rate" is not "error rate for the other guy". The residual bias is also not
fully gone: the held-out camera's detection still participated in forming the group, so
even this test is not perfectly neutral toward LUC3D.

---

### !! Read this before quoting any social-DANNCE number !!

**Every 2D input in the s-DANNCE experiments below is geometrically consistent with a
single 3D point set BY CONSTRUCTION. Both legs. There is no raw-detection result here.**

* The panel-scale leg is s-DANNCE's own 3D reprojected into the six cameras, so the
  correct cross-view correspondence is exact and the triangulation residual is 0 px. A
  real detector on our own rig sits at a 2.584 px median cross-view residual.
* The leg described in an earlier draft as the "human gold truth" is **not independent
  human 2D either.** Reprojecting the humans' `data_3d` through the converted calibration
  lands on their `data_2d` with **max error 0.0000 px over all 3,726 labelled instances
  in all six cameras** — a spread no six independent human clicks could produce. Label3D
  wrote reprojected 2D back into those files. Checked 2026-08-09.
* And there is no third option: **the released dataset contains no per-view 2D at all.**
  s-DANNCE is volumetric — image volumes straight to 3D, no 2D pose stage — so "run it on
  their raw detections" is not something the release supports.

So the honest reading of everything below is: **given exactly consistent 2D, does LUC3D's
association recover the right correspondence on a rig, species and skeleton it has never
seen? Yes, essentially always.** That is a generalisation result and an upper bound. It is
NOT evidence about performance on real detections, and "1 switch in 540,000 frames" must
never appear without that qualifier. The real-detection evidence for the tracker lives in
Figs 3 and 7, on BMimica and SLAP-2M, where the detections are real and the cross-view
identity ground truth is human.

The only bridge to realistic input is panel **e**, and even it models detector error as
i.i.d. Gaussian per keypoint per view. Real detectors fail in *correlated, structured*
ways — whole-instance swaps, limb flips, a missed animal, a false positive on bedding —
which additive noise does not simulate. Say so in the caption.

**To get a genuine raw-detection result on their rig** there is exactly one route: train a
2D detector on the BEDDING videos (36 mp4s, ~10.5 GB, not yet downloaded) using the 1,266
labelled instances as targets — they are derived, but they are accurate positions and make
perfectly good training labels — then run inference to get real per-view detections with
real misses and false positives. That is a genuine experiment and a genuine cost
(download, frame extraction, training, then inference over 540,000 camera-frames). It is
scoped, not started, and it is the honest upgrade path for panel d.

### Panel d — LUC3D's tracker on social-DANNCE's rig

Their six cameras, their rats, their `rat23` skeleton, nothing retrained. Calibration
conversion (DANNCE `hires_camN_params.mat` → anipose) is **verified at 0.000 px** by
reprojecting the humans' own `data_3d` onto their own `data_2d`.

**Human-labelled 2D, the gold-truth leg.** 53 frames across the four sessions that have
per-rat Label3D files, 6 cameras, 636 camera-instances, identity stripped by shuffling.
Scored with **single-frame association** (one independent run per frame — these frames are
thousands apart, and asking a temporal tracker to carry identity across those gaps tests
nothing): **the correct two-animal partition on 53 of 53 frames, 0 unassigned.**

**Close-interaction bouts, the hard regime.** Pooled over a whole session the two rats are
a median 159–365 mm apart and association is trivial, so the interesting frames are the
contiguous episodes where they are within 50 mm — 0.9–8.5% of frames depending on session.
85 such bouts (≥30 frames, padded 30 frames each side so the tracker enters with identity
already established), tracked as 85 independent temporal runs:
**16,046 frames, 192,552 camera-instances, 12,094 of those frames with the rats under
50 mm apart — perfect grouping on every frame and ZERO identity switches.**

**Full sessions — the headline n.** All six sessions at full length, 90,000 contiguous
frames each, 6 cameras, identity stripped: **540,000 frames, 6,480,000 camera-instances,
ONE identity switch in the entire corpus.** Five of six sessions are exactly perfect
(instance accuracy 1.000, grouping 1.000, 0 switches); `2024_05_07_F6_F2` takes a single
un-recovered switch, which leaves its grouping still perfect but its global identity
accuracy at 0.970. Grouping is 1.000 in every separation stratum, including all 14,231
frames where the rats are under 50 mm apart. Throughput 16 ms/frame, single-threaded
Node, no GPU.

Note the two numbers answer different questions and the caption must never quote one for
the other: **grouping** accuracy asks "did it put the right detections together in this
frame", **instance** accuracy asks "did it give them the same name it gave them an hour
ago". One switch destroys the second while leaving the first untouched — which is exactly
what `F6_F2` shows, and is worth saying out loud, because it is also the argument for why
a proofreading tool needs a 3D viewport.

### Panel e — where cross-view association actually breaks

The first attempt at this sweep was run over whole-session windows and came back **flat at
1.000 out to 40 px of noise, 50% keypoint dropout and 50% view loss**. That is not
robustness, it is the dataset: with the rats a median 159–365 mm apart, no plausible
amount of 2D noise creates an ambiguity, and only 12–23 of 3,000 frames were
close-interaction. **Do not publish that version** — a flat line at 1.0 reads as a strong
claim when it is an artefact of how far apart the animals were.

Rebuilt on the **85 close-interaction bouts** (16,046 frames, 192,552 camera-instances,
all six sessions, each bout an independent temporal run). Grouping accuracy and total
identity switches against three independent degradations of the 2D:

| degradation | grouping acc | switches | | degradation | grouping acc | switches |
|---|---|---|---|---|---|---|
| noise σ = 2 px | **1.0000** | 0 | | dropout 25% | 0.9993 | 3 |
| noise σ = 5 px | 0.9997 | 2 | | dropout 50% | 0.9772 | 84 |
| noise σ = 10 px | 0.9940 | 7 | | dropout 75% | 0.7159 | 1,061 |
| noise σ = 20 px | 0.9844 | 51 | | dropout 90% | 0.1020 | 5,986 |
| noise σ = 40 px | 0.9579 | 126 | | view loss 25% | **1.0000** | 0 |
| noise σ = 80 px | 0.8173 | 510 | | view loss 50% | **1.0000** | 2 |
| noise σ = 160 px | 0.4011 | 2,435 | | view loss 75% | 0.9995 | 6 |

Three things the panel should say, in this order:

1. **Mark the real operating point on the noise axis.** BMimica's measured cross-view
   residual is **2.584 px** median and Fig 2's held-out reprojection error is **4.32 px** —
   so a real, well-trained detector sits between the 2 px and 5 px rows, where this
   corpus's hardest 16,046 frames take **0–2 switches**. Association degrades gracefully
   and only starts to fail around 80 px, **20–30× worse 2D than any detector in this
   paper produces**. That is the answer to "how good does the 2D have to be", and it is
   the panel's headline.
2. **Losing whole cameras costs almost nothing; losing keypoints costs a lot.** Dropping
   75% of camera-views per frame still grouped 0.9995 of frames with 6 switches, while
   dropping 50% of *keypoints* cost 84. Six cameras carry enough redundancy that the
   association survives losing most of them — but it needs the detections it does get to
   be reasonably complete. This is a genuinely useful design finding and it is the kind of
   thing neither competitor can report, because neither has the stage.
3. **These are the hard frames.** Every number above is on close-interaction bouts only —
   the regime the s-DANNCE paper is about. On full sessions the same tracker takes one
   switch in 540,000 frames.

### Three harness bugs that produced publishable-looking wrong numbers

Recorded because each one produced a plausible table before it was caught:

1. **Wrong tracker.** The first sDANNCE run drove `matchFrameInstances`, which
   `pose/tracker.js:217` labels *"LEGACY … BENCH-ONLY … the app no longer uses it"*. It has
   no temporal layer, so identity followed the shuffle order: instance accuracy ~0.5, ~444
   switches per 1,000 frames — and the *same* switch count (3998/9000) in three different
   sessions, which was the tell. On `runCrossViewTracker` the same input scores perfectly.
2. **Wrong reference file.** The first BMimica run read
   `outputs/bmimica/gt/*/proofread.analysis.h5`, which holds *reprojections* of a common
   3D solve — so triangulating from C−1 views reproduced the held-out view exactly and all
   four methods scored 0.000 px.
3. **Wrong identity bookkeeping.** `runCrossViewTracker(..., propagate=true)` rewrites every
   instance's `trackIdx` and rebuilds `frameIdentityMap` against the new keys, after which
   reading the map by the index you constructed returns a trivial k→k that looks like a
   perfect score. Use `propagate=false` when reading identity back.

A fourth, in scoring: identity IDs are session-global and are **not** 0..A−1 — a
per-frame or per-bout run mints new ones — so slots must be mapped, and mapped at the
right granularity (per bout, not per frame; per frame made a perfect run report a 50%
switch rate).

---

## 5. What this figure must NOT claim

Written now, before any data exists, in the idiom of `CAPTIONS.md`'s "does not claim"
sections — these are the five ways this figure gets us into trouble.

1. **Not "Lightning Pose detects worse than SLEAP."** See §1. Our LP model is
   under-trained and its failure mode is misses, not identity. If the detector-swap axis
   appears anywhere it appears as a supplementary note with the training curve beside it.
2. **Not "LUC3D beats s-DANNCE at 3D pose."** We never run their network. Panel f
   compares our triangulation of *their* 2D against their published output; a difference
   there is a difference between a geometric solve and a volumetric CNN on one rig, at
   n = 44 frames.
3. **Not "LUC3D wins at cross-view identity."** Neither competitor *reports* cross-view
   identity, because neither has the stage. Panel d is "LUC3D holds identity on a rig,
   species and skeleton it was never tuned for," and panel a is "this stage is missing
   elsewhere." That is a positioning claim plus a generalisation result, and it must be
   phrased as both, not as a benchmark win. Fig 7a's 1/C ceiling argument is the
   template for saying this precisely.
4. **Not "our triangulator is better."** Fig 4 already establishes that solver choice
   moves the residual by 8% in-sample and 3% out-of-sample on this data, and that no 3D
   ground truth exists here to arbitrate. Panel b's honest headline is most likely
   **"four triangulators agree to within a fraction of a pixel; the choice does not
   matter and the association upstream of it does"** — which is a *better* result for
   this paper than winning, because it says the thing LUC3D contributes is the thing that
   matters. Write the panel expecting that outcome.
5. **Not a claim about the projected-2D regime without panel e.** Oracle 2D is
   consistent by construction. Panel d is only interpretable with panel e beside it.

---

## 6. Work plan

Ordered by (evidence gained) ÷ (cost). Stop after step 3 and there is still a figure.

**Step 0 — verification, ~1 h, no downloads beyond 10 MB.**
Pull all eight `*_RAT{1,2}_Label3D_dannce.mat` from the four BEDDING dyad sessions plus
their 24 calibration files (~16 MB total) and confirm per session: frame counts, the
RAT1∩RAT2 shared-sample count (11 in `F1_F3` — check the other three), keypoint order,
and that `data_2d` is genuinely NaN-free. **The whole sDANNCE half's n comes out of this
step**; if the shared counts are all ~11 the human leg is 44 frames and panel d leans on
the projected leg as designed. Write the `hires_camN_params.mat` → anipose `.toml`
converter here and verify it by reprojecting `data_3d` onto `data_2d` — that round-trip
is the calibration unit test, and it costs nothing.

**Step 1 — panel b, ~1 day.** Implement triangulators 3 and 4 behind the existing Fig 4d
evaluator. No new data, no new corpus, no third-party training. Deposit
`figs/data/fig8/fig8b_triangulators.csv`.

**Step 2 — panel c, ~0.5 day.** `pip install ensemble-kalman-smoother aniposelib`, clone
`paninski-lab/eks`, run `eks multicam --input-dir ./data/fly --calibration
./data/fly/calibration.toml` as documented, then run all four triangulators on the same
CSVs. Do this **before** step 1 quotes any EKS number: the fly demo is the only place we
can confirm our invocation reproduces the authors' own intended behaviour with the
ensemble they designed for, and it is the reference against which the single-seed
BMimica run in **b** is interpreted. Record the installed versions of `lightning-pose`,
`ensemble-kalman-smoother` and `aniposelib` into the deposit.

**Step 3 — panels a and g, ~0.5 day.** Pure documentation panels, same discipline as
`src/tools_table.py`: one docstring line of provenance per cell, `NEEDS_CHECK` on the
artwork until re-verified. Re-check Fig 1d's Lightning Pose row against **LP3D** while
here — the "multi-view losses" cell predates that paper.

**Step 4 — panels d and e, ~2–3 days.** Download `save_data_AVG0.mat` for the four dyad
sessions (~1 GB; videos are **not** needed unless a visual panel is wanted, which would
add ~1.5 GB for one session). Project to 2D, strip identity, run
`scripts/luc3d_track_all.mjs`, score with `scripts/evaluate.py`. The degradation sweep in
**e** is the same pipeline in a loop over (σ, dropout, occlusion) and is cheap once **d**
runs.

**Step 5 — panel f if wanted, ~0.5 day.** Skeleton mapping `rat23` → the shared subset.

**Step 6 — assembly.** `figs/panels/fig8_0N_*.py`, `figs/data/fig8/*.csv`,
`figures/fig8/`, and `LAYOUTS`/`TITLES`/`FOOTERS` in `assemble.py` **edited together**
(the README records that drifting those apart has already produced a wrong footer once).
Caption into `CAPTIONS.md` with its own "does not claim" section carrying §5 above.
Run `python3 figs/lint_text.py` before calling it done.

**Deferred, explicitly:** finishing the `slap2m_mvt` training run (24/50) and re-running
the detector swap. Worth doing — it is ~1 GPU-day and the pipeline is written — but it
belongs to a supplementary note, and the figure must not be scheduled behind it.

---

## 7. Open questions for Eric

1. **Panel c's dataset.** EKS's shipped `data/fly` is guaranteed available but is a demo
   clip. Is it worth chasing the full LP3D fly/chickadee releases (6 views, calibrated,
   30 and 18 keypoints) for a stronger external-validity leg, or is the demo enough?
2. **Panel g's framing.** "Zero GPU-hours, runs in a browser" is the strongest true claim
   in the whole figure and it is a *product* claim, not a benchmark. Nature Neuroscience
   figures usually carry it in Fig 1 (we already do, as Fig 1d). Does it earn a second
   appearance here, or does Fig 8 stay purely quantitative and let Fig 1d carry it?
3. **The detector swap.** Finish the LP model and report it if competitive, or drop the
   axis? My recommendation is finish-but-defer-to-supplement; it is your call whether the
   GPU-day is worth spending at all.
4. **Six panels or five?** **f** is the weakest and its ground truth is near-circular.
   Cutting it leaves a tight five-panel figure; keeping it adds the only direct
   LUC3D-vs-s-DANNCE 3D number in the paper, at n = 44 frames.
