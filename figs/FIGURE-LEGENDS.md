# Figure legends

Legends for the seven manuscript figures, in the order they appear in
`figures/drafts/luc3d.tex`: Figs 1 to 6 are `figures/fig1` to `figures/fig6`, and
Fig 7 is the combined view assembled as `figures/fig11`. Each legend gives a title,
then the panels in order, then the n. Procedures are in METHODS.md; which script made
which panel is in PANEL-SOURCES.md. A plain-text copy of this file, for pasting into a
word processor, is FIGURE-LEGENDS.txt (regenerate with `python3 figs/make_docs.py`).

---

## Fig. 1)

LUC3D annotates and proofreads multi-camera 3D pose in a browser with no
installation, and assigns cross-view identity.

A) The SLAP-2M rig (left) rendering: 8 camera calibration and cage with a
4-animal session's tracked 3D poses. The Mouse-Dyad-10M rig (right) rendering:
5 camera calibration and the two animals' 3D poses; the drawn volume is the
animals' 650 mm movement footprint, not an enclosure. Tiles print at one
height, not one scale.

B) Pipeline, from videos to export. Video acquisition, 2D pose estimation (SLEAP or
any other predictor as .slp), cameras are calibrated with a browser-based tool,
cross-view re-identification, one per animal; triangulation collapses the tiles into a
single 3D volume; the 3D is proofread against per-view reprojections; and the project
exports as .slp 2.8 or HDF5. The bracket marks the stages contributed by this paper.

C) One frame of an 8-camera, 3-mouse recording, 15-node skeleton. Left, the
per-camera tracks supplied to the app; right, the same two views after cross-view
re-identification (cam 0 mid and cam 7 sideR, 2 of 8 views). Labels are the
per-camera track name and the resolved identity. Track colours are arbitrary within
each camera and carry no meaning across views; identity colours are shared by every
view. Across all 8 views this frame holds 25 detections carrying 21 distinct track
names; 24 of the detections are assigned, resolving to 3 identities, one per animal
in every view, and 1 detection is left unassigned.

D) The same frame triangulated. Left, cam 0 mid with identity overlays; middle, the
3D viewport placed at that camera's own pose and field of view; right, the rig, with
7 of the 8 calibrated cameras and the 3 reconstructed animals, cropped to the
cluster (the eighth sits far outside it). 45 of 45 3D keypoints filled.

E) Capability comparison against 7 multi-animal or multi-camera pose tools, read from
each tool's published documentation. A dash means the capability is not documented,
except in the DANNCE and s-DANNCE cross-view cell, where it means not applicable.

---

## Fig. 2)

Reprojection-aided labelling protocol.

A) The protocol in the app: two anchor views labelled (cam 1 topB, cam 6 sideL), the
3D solved from those two alone and shown from the cam 6 sideL anchor's own
calibrated viewpoint, so it can be laid against that view directly; the
reprojection drawn into the two unlabelled views, and one of them magnified with
the cursor on a reprojected keypoint.

B) Manual placements per animal per frame against rig size C. Manual labeling, every
label by hand (C x N, N = 15 nodes); accept, the placements left when a reprojection
within tau = 10 px is taken as it lands; nudge, the same at tau = 5 px. Curves are the
model; the filled marker is the one measured rig, C = 5, where 32 of 75 are by hand,
57% free, 2.3-fold fewer.

C) 3D error against the cameras in the solve. Boxes, the 50 session medians (median,
IQR, whiskers 1.5x IQR), every session a dot: 4.74, 2.89, 1.91 and 1.19 mm at 2 to 5
cameras.

D) Median two-anchor 3D error against the angle the pair subtends at the animal, one
marker per camera pair. Dashed curve, k/sin(theta) with k = 1.52 mm; band, plus or
minus 25%; dotted line, the all-five-view floor, 1.2 mm. 12.6 mm at 13.5 degrees, 2.7
at 31.5.

Mouse-Dyad-10M: B and D, all 56 sessions, 286,200,174 keypoints; C, the 50 proofread
sessions. A is one frame of an 8-camera SLAP-2M session.

fig2s1) Supplementary, not placed in the composite. Cross-view IDF1 over deterministic
camera subsets, k of 5: per-k means 0.675, 0.736, 0.752 and 0.749.

---

## Fig. 3)

Cross-view tracking algorithm. Greedy per-camera assignment groups as well as
exhaustive enumeration at nearly a million-fold lower cost.

A) The two strategies: exhaustive enumeration of every grouping (Maree et al., 2024),
(A!)^C per frame, against LUC3D's one Hungarian assignment per camera, each committed
before the next, at O(C.A^3).

B) Hypotheses per frame for exhaustive enumeration, one curve per rig size; dotted
line, the harness cap of 10^6.

C) Frames misgrouped against proofread ground truth per 10,000 clean frames, by
configuration: pooled, 2.05 for LUC3D against 3.16 for exhaustive, and 4.7 against
85.2 at 4 animals in 3 cameras.

D) Ablation of the 3D term on the ratio r = corr3d/corr2d: cross-view IDF1 (right
axis) and switches per 100,000 camera-frames (left, log). Off, 632 switches; at the
default r = 6, 0.92 at IDF1 0.861. Flat rules, exhaustive over the 48% of frames it
can enter: IDF1 0.628 and 81.0 switches, against 0.791 and 8.0 for greedy on those
frames.

E) Time per frame on identical detections: exhaustive 11.5 ms at 2 animals in 5 cameras
to 1,980.9 s at the 4-in-6 lower bound, LUC3D 1.1 to 2.4 ms.

n = 92 sessions (50 Mouse-Dyad-10M, 42 SLAP-2M); 4,591,864 of 9,678,503 frames were
clean and all were computed. D is Mouse-Dyad-10M.

fig3s1) Supplementary, not placed in the composite. The two association cost terms drawn
separately: the 2D term on the distance to the target's reprojection, decayed by
target age, and the 3D term on the distance to the detection's back-projected ray.

---

## Fig. 4)

Triangulation accuracy is set by how many views contribute and by whether a badly
fitting view is dropped, not by the solver.

A) The two solvers the app ships: linear DLT, closed form, the default; and non-linear
triangulation in native pixels with the cameras fixed (app menu "Bundle Adjustment").
Padlocks mark fixed cameras.

B) Error in a camera outside the solve, every subset at each count: DLT 4.32, 3.66 and
3.34 px and refinement 4.42, 3.53 and 3.15 px at 2, 3 and 4 cameras. Bars, the
distribution-free 95% CI of the across-session median; paired, refinement minus DLT is
+0.111, -0.069 and -0.098 px.

C) Reprojection error in the kept views, all views in the solve against the same solve
with the worst view dropped; across-session means, bars the 95% CI of the mean. 2.06
to 1.71 px, a paired -0.345 px (95% CI -0.359 to -0.332), lower in 50 of 50 sessions.

D) Median reprojection error per session in the cameras the solve used, four solvers
paired by class. Boxes, the session distribution (median, IQR, whiskers 1.5x IQR):
Anipose linear 2.26, LUC3D DLT 2.35, Anipose optim 2.26 and LUC3D refined 2.15 px,
lowest in 50 of 50 sessions.

E) Solve time per keypoint, undistortion excluded from all four: 6.3 against 29.0 us
on the linear pair, 44.0 against 228.8 us on the non-linear.

n = 50 Mouse-Dyad-10M sessions at every 15th frame, 17,013,412 keypoints, the same
keypoints in every column. Anipose is aniposelib 0.7.2, ransac and smoothing off.

---

## Fig. 5)

Behavioural analysis of social rearing. Two mice rear together face to face, and one
animal of each pair starts 80% of the displays.

A) One display in five views, with the 3D reconstruction. Every camera sits 58 to 76
degrees above the animals, so the height that defines the event exists only after
triangulation. Only the 3D panel is metric (230 x 230 x 140 mm), and the wall of
that volume nearest the viewer is drawn as edges only so the interior is seen
through clear air.

B) Time course around onset: across-session median of per-session medians, band p25 to
p75. The height curves are within-display ranks, not individuals; the nose gap falls
to 0.12 body lengths at onset.

C) Time the initiator is up before the follower joins: median 0.37 s (p25 to p75, 0.16
to 0.89 s); hatched bar, the 8% beyond 2 s.

D) Separation velocity of the two tail bases (left axis; negative is closing) and each
animal's speed over its own baseline (right axis), by role.

E) Speed during the display over that animal's own session median: median 0.44, 94% of
displays below baseline, median duration 0.71 s.

F) Share of displays started by the session's leader, over the 23 sessions with six
or more displays, against a size-matched fair-coin surrogate that keeps each
session's own display count and only relabels who started. Boxes, median and IQR,
whiskers 1.5x IQR; medians 0.86 and 0.57. Pooled over all 539 displays in 37
sessions the leader starts 432 of them, 80.1%. Stars, P < 0.0005, the bound from
2,000 surrogate corpora none of which reaches the observed median.

G) Probability the other animal is rearing at each lag around a rear onset, over its
own base rate; lines, across-session medians, band p25 to p75. Within 2 body lengths,
2.9 at onset and 4.1 at half a second; beyond, flat at 1.05, null 0.99.

Mouse-Dyad-10M: 539 displays in 37 of 56 sessions (2 mice, 5 cameras, 150 fps); G uses
9,354 onsets over all 56. A display is both animals reared, neck above 0.75 body
length, tail bases within 2 body lengths, held at least 0.25 s.

---

## Fig. 6)

Multi-animal mouse social behaviour datasets. Difficulty removes keypoints rather than
degrading them.

A) The two axes that set a session's difficulty, rendered from the data. Each
cage is one SLAP-2M session recorded at that combination of animal count and
environmental enrichment, drawn from its own cage corners and tracked 3D poses.
Only the conditions the corpus contains are shown, so the empty cells are absent
from the data rather than omitted from the figure. The green enrichment objects
are illustrative props at the rated level, since no object positions were
recorded. The wall nearest the viewer is drawn as edges only, so the interior is
seen through clear air. The inset, marked by the dashed box and leaders, shows
the same instant of the 4-animal session as seen by its six proofread cameras,
each view cropped to the app's bounding box, with scale bars of 50 mm. An animal
carries the same colour in the inset as in the cage the inset expands.

B) Cross-view IDF1 by difficulty over the 42 multi-animal sessions; boxes, stratum
median and IQR, whiskers 1.5x IQR, one dot per session: 0.989 to 0.923 at ratings 2 to
5, then 0.829 and 0.649.

C) Keypoints missing per view after reprojection recovery, by difficulty and rig
size: at rating 7, 57.1% at two cameras falls to 37.7% at six.

D) The same miss rate within each animal count (n = 32, 35, 4, 3 sessions for 1 to 4
animals); bars, +-1 s.d. between sessions; hollow markers, single-session cells.

E) Raw per-camera detection quality against difficulty: keypoints missing
(10.81-fold), error when present (mean +- s.d. between sessions, with p95; 1.30-fold),
and the fraction beyond the app's 20 px tolerance (5.72-fold).

F) Per stratum: sessions, keypoints, animal counts, bedding, error mean, p95, p99 and
the fraction beyond 20 px.

SLAP-2M: C, D, E, F on all 74 sessions; B on the 42 multi-animal sessions.

fig6s4) Supplementary, not placed in the composite. Per-view miss rate against difficulty,
one line per animal count: at matched difficulty more animals is worse (rating 4:
11.9, 19.0 and 39.5% for 1, 2 and 4 animals).

---

## Fig. 7)

Cross-view identity, and transfer to rats.

A) Within-view against cross-view IDF1, mean +- 95% bootstrap CI over sessions: LUC3D
0.861 to 0.861, SLEAP 0.642 to 0.146, ByteTrack 0.676 to 0.157, 3D-MuPPET 0.011.

B) Within-view IDF1 as a survival curve, one step per session; at 0.9 or above, 39, 22
and 10 of 74.

C) Paired within-view difference, LUC3D minus SLEAP: +0.142, +0.075, -0.052, -0.080 at
1 to 4 animals; over 2 animals, +0.052 (n = 42, 30/42, P = 0.01).

D) False positives and ID switches as percentages of camera-frames: 0.317, 0.531,
0.435% and 0.0264, 0.0308, 0.105%. False negatives (98.8-99.3% of each budget) are
not plotted.

E) Session IDF1 against the shared detector's recall, diagonal where the two are equal:
r = 0.990, 0.945, 0.775.

F) Paired fragmentations per camera-session, LUC3D minus SLEAP, mean +- 95% bootstrap
CI: +6.2 (+3.0 to +10.4), median +1.3; SLEAP fewer in 72/74.

G) One camera view per social-DANNCE family (TRIADS, 3 rats; BEDDING, SCN2A, 2 rats),
the deposit's sDANNCE 3D reprojected through its calibration; G to M run the shipped
tracker on those reprojections, identity shuffled per frame and view.

H) Reprojected centre-of-mass labels against raw 2D clicks, per camera over six TRIADS
sessions: pooled median 5.7 px; boxes, IQR, whiskers 1.5x IQR.

I) Cross-view IDF1 against Gaussian 2D noise per keypoint per view: at or above 0.96
through sigma = 5 px, then 0.98, 0.88, 0.94 at sigma = 20.

J) IDF1 under instance, per-node and occlusion-correlated dropout at sigma = 3 px;
BEDDING hit hardest, 0.76 at 50% instance dropout.

K) The 23-node skeleton against one centre-of-mass point per animal, both arms from the
same source: 0.992 against 0.985 at sigma = 0.

L) Switch rate per 100,000 frames against cameras used: flat at working noise; under
25% instance dropout, 130-190 at two cameras and 4.2-9.3 at six.

M) Switch rate per 100,000 camera-frames along the noise and dropout axes: 0.04-0.09 at
sigma = 0, rising to 1.5, 3.3, 6.6 at sigma = 20. Dashed, the 0.92 per 100,000 measured
on real Mouse-Dyad-10M detections (Fig. 3D).

A, 50 Mouse-Dyad-10M sessions (shipped config); B to F, all 74 SLAP-2M sessions,
11,726,640 camera-frames (previous default); G to M, 41 social-DANNCE sessions.

fig7s3) Supplementary, not placed in the composite. Within-view IDF1 of the three trackers
by SLAP-2M difficulty: the order LUC3D, SLEAP, ByteTrack holds in all seven strata,
falling from 1.00, 1.00 and 0.95 at rating 1 to 0.36, 0.31 and 0.18 at rating 7.

fig7s4) Supplementary, not placed in the composite. ID accuracy on the 50 Mouse-Dyad-10M
sessions (IDA = idtp / num_matches): the shipped configuration pools to 92.46% with a
session median of 100.0%, against the previous default's 80.56% and 84.0%.

---

## Production notes (not for the manuscript)

Fig 6 assembles 180 x 249 mm, over the 200 mm page ceiling; which panel to cut or
shrink is pending Eric's decision.

Fig 7m's dashed reference is annotated "real detections (Fig 8)" on the artwork.
Figure 8 is exploratory and unplaced, and the 0.92 per 100,000 it points at is Fig 3d's
shipped arm, so the annotation needs to read "Fig 3d" before submission.
