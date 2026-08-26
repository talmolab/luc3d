# Figure legends

Legends for the SIX manuscript figures (renumbered 2026-08-25, Eric: "there are
only 6 main figures now"). The manuscript number maps onto the repo's figure
directories as follows -- the directories keep their historical numbers so no
panel script, deposit or sync path had to move:

    Fig 1 = figures/fig1     Fig 4 = figures/fig5
    Fig 2 = figures/fig2     Fig 5 = figures/fig6
    Fig 3 = figures/fig13    Fig 6 = figures/fig11

The old standalone Figs 3 (tracking algorithm) and 4 (triangulation solvers) are
gone as their own figures: Fig 3's panels live on in figures/fig13 (the new
Fig 3) and Fig 4's data panels are Fig 2's third row (E to G; its solver diagram
was dropped). Each legend gives a title, then the panels in order, then the n.
Procedures are in METHODS.md; which script made which panel is in
PANEL-SOURCES.md. A plain-text copy of this file, for pasting into a word
processor, is FIGURE-LEGENDS.txt (regenerate with `python3 figs/make_docs.py`).

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
per-camera track name (T 82) and the resolved identity (ID 1); skeletons are drawn
from the exported 2D detections. Track colours are arbitrary within
each camera and carry no meaning across views; identity colours are shared by every
view. Across all 8 views this frame holds 25 detections carrying 21 distinct track
names; 24 of the detections are assigned, resolving to 3 identities, one per animal
in every view, and 1 detection is left unassigned.

D) The same frame triangulated. Left, cam 0 mid with identity overlays; middle, the
triangulated 3D poses in the overlays' identity colors, on the arena floor plane
fitted from the animals' own movement (the 0.1-99.9 percentile footprint of every
triangulated keypoint across the session); right, the rig, that footprint extruded
by its shorter side, with 7 of the 8 calibrated cameras and the 3 reconstructed
animals (the eighth camera sits far outside the cluster). 45 of 45 3D keypoints
filled.

E) Capability comparison against 7 multi-animal or multi-camera pose tools, read from
each tool's published documentation. A dash means the capability is not documented,
except in the DANNCE and s-DANNCE cross-view cell, where it means not applicable.

---

## Fig. 2)

Reprojection-aided labelling protocol, and the triangulation it rests on.

A) The protocol in the app: two anchor views labelled (cam 1 topB, cam 6 sideL;
solid skeletons in identity colours, drawn from the app's exported 2D), and the
3D solved from those two alone -- rendered ball-and-stick in the same identity
colours on the movement-fitted arena floor, from the cam 6 sideL anchor's own
calibrated viewpoint, so it can be laid against that view directly. The
two-anchor reprojection is drawn dashed into the two unlabelled views, and one
of them is magnified with the detection solid under the dashed reprojection and
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

E) Solver accuracy against the cameras used. The two solvers are the app's own:
closed-form linear DLT (the default) and non-linear refinement in native pixels
with the cameras fixed. Top, error in a camera outside the solve, every subset at
each count: DLT 4.32, 3.66 and 3.34 px and refinement 4.42, 3.53 and 3.15 px at 2,
3 and 4 cameras (bars, the distribution-free 95% CI of the across-session median;
paired, refinement minus DLT is +0.111, -0.069 and -0.098 px). Bottom,
reprojection error in the kept views, all views in the solve against the same
solve with the worst view dropped; across-session means, bars the 95% CI of the
mean: 2.06 to 1.71 px, a paired -0.345 px (95% CI -0.359 to -0.332), lower in 50
of 50 sessions.

F) Median reprojection error per session in the cameras the solve used, four solvers
paired by class. Boxes, the session distribution (median, IQR, whiskers 1.5x IQR):
Anipose linear 2.26, LUC3D DLT 2.35, Anipose optim 2.26 and LUC3D refined 2.15 px,
lowest in 50 of 50 sessions.

G) Solve time per keypoint, undistortion excluded from all four: 6.3 against 29.0 us
on the linear pair, 44.0 against 228.8 us on the non-linear.

Mouse-Dyad-10M: B and D, all 56 sessions, 286,200,174 keypoints; C, the 50 proofread
sessions; E to G, the 50 proofread sessions at every 15th frame, 17,013,412
keypoints, the same keypoints in every column (Anipose is aniposelib 0.7.2, ransac
and smoothing off). A is one frame of the 8-camera HardFight recording (the same
clip as Fig 1c/d; CAPTIONS.md and METHODS.md already name it so).

fig2s1) Supplementary, not placed in the composite. Cross-view IDF1 over deterministic
camera subsets, k of 5: per-k means 0.675, 0.736, 0.752 and 0.749.

---

## Fig. 3)

Cross-view tracking algorithm. Greedy per-camera assignment groups as well as
exhaustive enumeration at nearly a million-fold lower cost. (Assembled as
figures/fig13.)

A) The two strategies: exhaustive enumeration of every grouping (Maree et al., 2024),
(A!)^C per frame, against LUC3D's one Hungarian assignment per camera, each committed
before the next, at O(C.A^3).

B) Hypotheses per frame for exhaustive enumeration, one curve per rig size; dotted
line, the harness cap of 10^6.

C) What one grouping hypothesis is, on one real frame of a 3-animal SLAP-2M
session seen by two of its calibrated cameras (side and top). Every candidate
cross-view pairing is a thin grey line -- 3 x 3 between these two views alone --
and the three correct pairings are singled out in colour as closed triangles:
image detection to the animal's real triangulated 3D to the other view's image
detection. Dashed white marks the top camera's detections before any pairing is
chosen (the legend's "unresolved detection").

D) An identity switch, staged from one real HardFight frame in the same two-view
vocabulary as C. The top camera's two identities are exchanged (the white curved
arrows); the side camera is correct. Solid legs tie each correct 2D detection to
its 3D instance on the floor; the dotted legs run a colour gradient between the
two identities, so a leg that starts orange and ends blue IS the statement that
one animal is carrying two identities.

E) Grouping accuracy: frames misgrouped against proofread ground truth per
100,000 clean frames, pooled across the animals-x-cameras configurations; boxes,
the per-session distribution on a symlog axis, every session a dot, the white
line the median. The shipped fresh-anchor greedy misgroups 926 frames against
exhaustive's 1,309 over 4,572,172 clean frames (20.3 against 28.6 per 100,000);
at 4 animals in 3 cameras the per-session medians are 0 against 880 per 100,000.

F) Time per frame on identical detections: exhaustive 11.5 ms at 2 animals in 5
cameras to 1,980.9 s at the 4-in-6 lower bound, LUC3D 1.1 to 2.4 ms.

G) Ablation of the 3D term on the ratio r = corr3d/corr2d: ID switches per
100,000 camera-frames (log). Off, 632 switches; at the app default r = 6, 0.92.
Flat rules, exhaustive over the 48% of frames it can enter: 81.0 switches
against 8.0 for greedy on those frames.

H) The same sweep's cross-view IDF1: 0.861 at the default r = 6, against the
exhaustive rule's 0.628 (greedy scores 0.791 on the frames exhaustive can
enter).

n = 92 sessions (50 Mouse-Dyad-10M, 42 SLAP-2M); 4,591,864 of 9,678,503 frames were
clean and all were computed. C is one frame of a 3-animal SLAP-2M session, D one
frame of the HardFight recording; G and H are Mouse-Dyad-10M.

fig3s1) Supplementary, not placed in the composite. The two association cost terms drawn
separately: the 2D term on the distance to the target's reprojection, decayed by
target age, and the 3D term on the distance to the detection's back-projected ray.

---

## Fig. 4)

Behavioural analysis of social rearing. Two mice rear together face to face; the
female starts 80% of the displays and the male joins her. (Assembled as
figures/fig5. Male is blue and female red in every panel.)

A) One display: the metric 3D reconstruction (230 x 230 x 140 mm; the wall nearest
the viewer is drawn as edges only so the interior is seen through clear air)
beside the same instant projected into each of the five cameras. Every camera sits
58 to 76 degrees above the animals, so the height that defines the event exists
only after triangulation.

B) Nose height by sex and the nose gap, around display onset: across-session
median of per-session medians, band the across-session p25 to p75. Both animals
rise and peak together, the noses converge to 0.12 body lengths at onset, and the
female reaches higher (hers is the higher peak on 80.9% of displays -- the curves
are keyed by SEX, not by within-display rank).

C) How long the female is up before the male joins, over her 432 female-led
displays: median 0.39 s (p25 to p75, 0.17 to 0.90 s); hatched bar, the 9% beyond
2 s. The male-led displays are excluded rather than folded in (their own lag is
similar, median 0.32 s).

D) Speed in the 0.5 s before onset, over each animal's own session baseline: the
male is travelling (median 0.382 body lengths/s) and the female is not (0.231);
boxes, median, IQR and 1.5x-IQR whiskers; paired Wilcoxon over the 538 displays
with both defined, P = 6.5e-22.

E) Facing-pursuit in the same pre-onset window -- each animal's facing axis dotted
with the direction away from its partner, scaled by its own relative speed, so
negative means moving TOWARD the partner along its own heading: male median
-0.708 against female -0.058 (paired Wilcoxon, n = 538, P = 3.3e-73). The male is
pursuing; the female is neither approaching nor fleeing.

F) Share of displays started, by sex, one value per session: session medians 0.857
(female) against 0.143 (male) over the 23 sessions with six or more displays
(paired Wilcoxon P = 2.7e-05); the female leads outright in 36 of 37 sessions with
any display (1 tie). Pooled over all 539 displays she starts 432, 80.1%; dashed
line, the fair coin at 0.5.

G) Rear-onset coupling, both directions: the probability the OTHER animal is
rearing at each lag around a rear onset, over that animal's own chance rate, for
onsets with the pair within 2 body lengths; yellow, the same onsets further
apart; grey, a circular-shift null. Around a FEMALE onset (left) the male sits
below his chance rate at lag 0 (0.6x, he is not yet up) and climbs to 1.7x about
0.8 s later; around a MALE onset (right) the female is already 4.7x above hers at
lag 0, peaking at 5.3x a third of a second later -- she is already mid-rear at
50.2% of his near onsets, against 6.2% for the reverse.

Mouse-Dyad-10M: 539 displays in 37 of 56 sessions (2 mice per session, one male
and one female, 5 cameras, 150 fps); D and E use the 538 displays with both
animals tracked in the pre-onset window; G uses 9,354 rear onsets over all 56
sessions, 2,915 of them within 2 body lengths. A display is both animals reared,
neck above 0.75 body length, tail bases within 2 body lengths, held at least
0.25 s.

---

## Fig. 5)

Multi-animal mouse social behaviour datasets. Difficulty removes keypoints rather than
degrading them. (Assembled as figures/fig6.)

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

fig5s4) Supplementary, not placed in the composite (deposited under the old fig6s4
name). Per-view miss rate against difficulty,
one line per animal count: at matched difficulty more animals is worse (rating 4:
11.9, 19.0 and 39.5% for 1, 2 and 4 animals).

---

## Fig. 6)

Cross-view identity, and the fresh-anchor staleness horizon. (Assembled as
figures/fig11.)

A) Within-view against cross-view IDF1, mean +- 95% bootstrap CI over sessions: LUC3D
0.861 to 0.861 (the shipped fresh-anchor configuration: sync, stale 20, distThresh
25), SLEAP 0.642 to 0.146, ByteTrack 0.676 to 0.157. The dashed rule at 1/C = 0.20 is
the camera-scoped pooling convention for a per-camera tracker, not a chance level.
3D-MuPPET is not drawn: its 0.011 to 0.011 is a coverage number (its assignments
cover a median 1.3% of a session, and unlabelled frames score as misses), not an
identity score on the same footing.

B) Within-view IDF1 as a survival curve, one step per session, each session's IDF1
the mean over its 6 cameras; at 0.9 or above, 39, 22 and 10 of 74 (LUC3D, SLEAP,
ByteTrack).

C) Paired within-view difference, LUC3D minus SLEAP, by animal count. Boxes, the
per-session differences (median, IQR, whiskers 1.5x IQR; every session also a dot):
medians +0.142, +0.060, -0.058, -0.066 at 1 to 4 animals (paired means +0.142,
+0.075, -0.052, -0.080), LUC3D winning 25/32, 30/35, 0/4 and 0/3 sessions; over 2
animals, mean +0.052 (n = 42, 30/42, P = 0.01).

D) False positives and ID switches as percentages of camera-frames: 0.317, 0.531,
0.435% and 0.0264, 0.0308, 0.105%. False negatives (98.8-99.3% of each budget) are
not plotted.

E) The tracker's two association cost terms on one real frame (drawn in the style of
Chen et al., 2020): the 2D term against the retained per-view 2D anchor (the dashed
translucent blue outline pose), and the 3D term as the detection's back-projected ray
against the 3D anchor node. The retained anchor is what panel F's staleness window
evicts.

F) The fresh-anchor parameter sweep, all 50 proofread Mouse-Dyad-10M sessions,
45,021,960 camera-frames, sessions paired across parameter sets; every candidate is
M1 + distThresh 25 + the stale window named in the key. Left, the identity
precision-recall plane: one operating point per parameter set at the across-session
median (identity recall x, identity precision y), whiskers the IQR on both axes
(operating points, not a swept curve: this detection pool has no score to
threshold). Middle, cross-view IDF1 as a survival curve.
Right, ID switches as a percentage of camera-frames; the raw totals behind the
percentages are 2,071 (no eviction), 677, 511, 413 and 487 (stale 1, 10, 20, 30) --
no eviction 0.00460% against stale 20 at 0.00092%, 80% lower, with median cross-view
IDF1 0.7604 to 0.9153.

A, 50 Mouse-Dyad-10M sessions (shipped config); B to D, all 74 SLAP-2M sessions,
11,726,640 camera-frames (previous default); E is one frame of a two-animal SLAP-2M
session; F, the 50 proofread Mouse-Dyad-10M sessions. The tracker key under panels
A to D (LUC3D teal, SLEAP periwinkle, ByteTrack orange) names the three colours
once for all four panels; F's parameter-set key is the strip along its own bottom.

fig6s3) Supplementary, not placed in the composite (deposited under the old fig7s3
name). Within-view IDF1 of the three trackers
by SLAP-2M difficulty: the order LUC3D, SLEAP, ByteTrack holds in all seven strata,
falling from 1.00, 1.00 and 0.95 at rating 1 to 0.36, 0.31 and 0.18 at rating 7.

fig6s4) Supplementary, not placed in the composite (deposited under the old fig7s4
name). ID accuracy on the 50 Mouse-Dyad-10M
sessions (IDA = idtp / num_matches): the shipped configuration pools to 92.46% with a
session median of 100.0%, against the previous default's 80.56% and 84.0%.

---

## Production notes (not for the manuscript)

The 2026-08-25 renumbering is a LEGEND-side mapping so far: the figure
directories, panel scripts, deposits and `figures/drafts/luc3d.tex` all still
carry the old numbers (the tex includes figs/fig3.pdf and figs/fig4.pdf, which
are no longer manuscript figures, and numbers the rest 1-7). Re-sync the tex --
its \includegraphics targets, captions and every \ref -- before submission.

Fig 5 (assembled as figures/fig6) is 180 x 249 mm, over the 200 mm page ceiling;
which panel to cut or shrink is pending Eric's decision.

Fig 10g's dashed reference (the s-DANNCE switches panel; not a manuscript figure)
is annotated "real detections (Fig 8)" on the artwork. Figure 8 no longer exists
as its own figure -- its fresh-anchor sweep ships as the new Fig 6's panel F
(fig11f) -- and the 0.92 per 100,000 it points at is the r = 6 point of the new
Fig 3's panel G (fig13g), so the annotation needs to read "Fig 3g" before
submission.
