# Figure legends

Legends for Figs 1 to 7. Each states the finding, then takes the panels in order.
Supplementary panels (S-numbered) follow their parent figure's entry; none is placed
in a composite. Procedures are in METHODS.md. A plain-text copy of this file, for
pasting into a word processor, is FIGURE-LEGENDS.txt.

---

## Fig. 1)

LUC3D annotates and proofreads multi-camera 3D pose in a browser with no installation,
and gives each animal one identity in every view.

A) Both rigs, each rendered from one of its own sessions' data. Left, SLAP-2M: eight
calibrated cameras, the measured cage, and two animals' tracked 3D poses. Right,
Mouse-Dyad-10M: five calibrated cameras over a 650 mm square arena, and two animals in a
mutual upright display. No cage geometry is reconstructed for that corpus, so the cube
is the footprint the animals covered, extruded by its own side; it is a container drawn
around the measurement, not a measured enclosure. The two tiles print at one height,
not one scale.

B) Pipeline from per-camera videos through 2D pose estimation, cross-view
re-identification, DLT triangulation, 3D proofreading and export to .slp 2.8 or HDF5,
with the bracket marking the stages contributed here. Calibration is one of those
stages: an OpenCV.js browser tool, placed before cross-view re-identification because
that is the first stage to consume its .toml, through the 3D term in the association
cost.

C) One frame of an 8-camera, 3-mouse recording: per-camera tracks at left, the same two
views after cross-view re-identification at right, 24 of the frame's 25 detections
resolving to 3 identities.

D) The same frame triangulated, as a camera view with identity overlays, the 3D viewport
at that camera's pose, and the full rig; 45 of 45 3D keypoints filled.

E) Capability comparison against 7 multi-animal or multi-camera pose tools, read from
each tool's published documentation on 5 August 2026.

---

## Fig. 2)

Labelling two anchor views and accepting the reprojection in the rest cuts manual
keypoint placements 2.3-fold on a 5-camera rig, because only 5.5% of reprojections
fall outside a 10 px tolerance.

A) The protocol in the app: two anchor views labelled, the 3D solved from those two
alone, and the reprojection drawn into the remaining unlabelled views.

B) Labels per animal per frame against rig size C, with the free share modelled at
tau = 10 px and 5 px; at C = 5 and tau = 10 px, 43 of 75 labels arrive free (57%).

C) 3D error in mm against the number of cameras in the solve: medians 4.74, 2.89, 1.91
and 1.19 mm at k = 2, 3, 4 and 5.

D) Median two-anchor 3D error against the pair's baseline angle, against the law
k/sin(theta) with k = 1.52 mm: 12.6 mm at 13 degrees down to 2.7 mm at 31 degrees.

n: A is one frame of the 8-camera application session; B and D rest on all 56 Mouse-Dyad-10M
sessions, 286,200,174 keypoints; C on the 50 proofread sessions, 442,348,712 solves.

S1) Supplementary; not placed in the composite. Cross-view IDF1 over deterministic
camera subsets, k of 5: per-k means 0.675, 0.736, 0.752 and 0.749.

---

## Fig. 3)

Greedy per-camera Hungarian assignment chooses the same grouping as exhaustive
hypothesis enumeration on 4,591,055 of the 4,591,864 frames both could be scored on
across 92 sessions (99.982%), at nearly a million-fold lower cost in the
configuration where enumeration becomes intractable.

A) The two search strategies: exhaustive hypothesis testing (Maree et al., 2024) at
(A!)^C groupings per frame, against LUC3D's per-camera Hungarian assignment at O(C·A³).

B) Hypotheses per frame for exhaustive enumeration, one curve per rig size, with the
harness cap of 10⁶ marked.

C) Frames misgrouped against proofread ground truth, per 10,000 clean frames: pooled,
the fresh anchor costs 2.05 against exhaustive's 3.16.

D) Ablation of the 3D term on a shared r = corr3d/corr2d axis: the term switched off
costs 632 switches per 100,000, the app default r = 6 holds 0.92 at IDF1 0.8613.

E) Measured time per frame on identical detections: exhaustive rises from 11 ms at
2 x 5 to 1,980.9 s at the 4 x 6 lower bound, LUC3D holds 1.1 to 2.4 ms throughout.

92 sessions: 50 Mouse-Dyad-10M at 2 x 5 plus every SLAP-2M session with pool detections and
proofread ground truth; 4,591,864 of 9,678,503 frames were clean and all were computed.

---

## Fig. 4)

Triangulation accuracy is set by how many views contribute and by whether a badly
fitting view is rejected, rather than by the choice of solver: 4.32 to 3.34 px in a
camera the solve never saw as views go from 2 to 4, and a median 7.2 mm displacement
from dropping one view that disagrees by 10 px or more.

A) The two solvers the app ships, linear DLT and non-linear refinement (menu name
"Bundle Adjustment"), with padlocks marking the fixed cameras.

B) Error in a camera outside the solve: DLT 4.32, 3.66 and 3.34 px and refinement 4.42,
3.54 and 3.15 px at 2, 3 and 4 cameras.

C) Reprojection error in the kept views per session, all views against the same solve
with the worst view dropped: the mean falls 2.06 to 1.71 px in 50 of 50 sessions.

D) Median reprojection error per session for four solvers; LUC3D's refinement is lowest
in-sample, while held-out Anipose leads both pairs (3.11 against 3.34 and 3.15 px).

E) Solve time per keypoint: LUC3D is 4.6 times faster on the linear pair (6.3 against
29.0 us) and 5.2 times on the non-linear pair (44.0 against 228.8 us).

Anipose is aniposelib 0.7.2, with ransac and temporal smoothing off.

---

## Fig. 5)

Two mice rear together face to face, and one animal of each pair starts 80% of the
displays.

A) One display in five views, the 3D reconstruction and the same instant as each camera
saw it; only the 3D render is metric (230 x 230 x 140 mm).

B) Time course around display onset, across-session median with a p25 to p75 band; the
nose gap falls to 0.12 body lengths at onset.

C) Time the initiator is up before the follower joins, over all 539 displays, median
0.37 s (p25 to p75, 0.16 to 0.89 s).

D) Separation velocity of the two tail bases and each animal's speed relative to its own
baseline, by role.

E) Speed during the display as a multiple of that animal's own session median, median
0.44, with 94% of displays below baseline.

F) Leader share against the number of displays per session, n = 37; pooled, 432 of 539
displays (80.1%) are started by the session's leader.

G) Probability that the other animal is rearing at each lag around a rear onset, over
its base rate: within 2 body lengths the curve peaks at 4.1, beyond it stays at 1.05.

n = 539 displays from 37 of 56 sessions (2 mice, 5 cameras, 150 fps); a display is both
animals reared, neck above 0.75 body length, tail bases within 2 body lengths, held at
least 0.25 s. G uses all 56 sessions and 9,354 rear onsets.

---

## Fig. 6)

Session difficulty acts on whether a keypoint is detected rather than on how well: the
per-view miss rate rises 10.8-fold across strata (5.3% to 57.7%) while the mean error
of the detections that do fire rises 1.30-fold (3.65 to 4.74 px).

A) The rig as LUC3D renders it, all 8 cameras with the frame's reconstructed animals and
the boxed cluster of 4 magnified.

B) One frame across the 6 proofread cameras, cropped to the app's bounding box and
coloured by identity; scale bars, 50 mm.

C) Keypoints still missing per view after reprojection recovery, by difficulty and rig
size k = 2 to 6: recovery at k = 6 takes the residual from 26.1% to 14.2%.

D) The per-view miss rate re-run within each animal count (n = 32, 35, 4 and 3 sessions
for 1 to 4 animals), error bars plus or minus 1 s.d. between sessions.

E) Cross-view IDF1 by difficulty over the 42 multi-animal sessions: stratum medians hold
between 0.989 and 0.923 at ratings 2 to 5, then fall to 0.829 at 6 and 0.649 at 7.

F) Corpus composition, attributes down and corpora across, totalling 130 sessions and
12,039,174 frames.

G) Raw per-view detection quality against difficulty: keypoints missing rises
10.81-fold, error of those present 1.30-fold, the fraction beyond 20 px 5.72-fold.

H) Per difficulty stratum: sessions, keypoints, animal counts, bedding split, error
mean, p95 and p99, and the fraction beyond 20 px.

n: D, G and H rest on all 74 sessions, 187,134,382 keypoint comparisons; C on the same
74 sessions, 42,184,875 keypoint-instances; E on the 42 multi-animal sessions. A and B
are one further session.

Note on size: the assembled figure runs 249 mm tall, over the 200 mm ceiling; which
panel to cut or shrink is pending Eric's decision.

S4) Supplementary; not placed in the composite. Per-view miss rate against difficulty,
one line per animal count: at matched difficulty more animals is worse (rating 4: 11.9,
19.0 and 39.5% for 1, 2 and 4 animals).

---

## Fig. 7)

On identical detections, LUC3D is the only method whose identities survive being
pooled across cameras: its IDF1 is unchanged from within-view to cross-view scoring
(retention 1.00) while per-camera trackers, even re-run at the most favourable
configuration we could give them, keep 0.23 of theirs. The same configuration transfers
without re-tuning to three rat datasets from an independent deposit (G to M).

A) Within-view against cross-view IDF1 over 50 Mouse-Dyad-10M sessions: LUC3D 0.861 to 0.861
(retention 1.00), capped SLEAP 0.642 to 0.146 and stitched ByteTrack 0.676 to 0.157
(0.23 each), with 3D-MuPPET flat at 0.011 on 1.3% median coverage.

B) Within-view IDF1 over 74 sessions as a survival curve; LUC3D's mean is 0.752 and its
median 0.920.

C) Paired within-view IDF1, LUC3D minus SLEAP, by animal count: +0.142, +0.075, -0.052
and -0.080 at 1 to 4 animals, pooling to +0.091 (55 of 74, sign test P = 3 x 10⁻⁵).

D) False positives and ID switches over 11,726,640 camera-frames: 0.317%, 0.531% and
0.435% false positives and 0.0264%, 0.0308% and 0.105% switches for the three trackers.

E) Session within-view IDF1 against the shared detector's recall: LUC3D r = 0.990, SLEAP
r = 0.945, ByteTrack r = 0.775.

F) Paired fragmentations per camera-session, LUC3D minus SLEAP: mean +6.2 (95% CI +3.0
to +10.4), median +1.3.

G) One camera view per social-DANNCE family with the deposit's sDANNCE 3D poses
reprojected through its own calibration; G to M run the shipped tracker on detections
synthesized from those tracks, identity shuffled per frame and per view.

H) Calibration anchor: reprojected 3D centre-of-mass labels against the labeller's raw
2D clicks over the six TRIADS sessions, pooled median 5.7 px.

I) Cross-view IDF1 against i.i.d. Gaussian 2D noise per keypoint per view: pooled lines
hold at 0.96 or above through sigma = 5 px and reach 0.98, 0.88 and 0.94 at sigma = 20.

J) IDF1 under whole-instance, per-node and occlusion-correlated dropout at sigma = 3 px;
BEDDING is hit hardest, pooled 0.76 at 50% instance dropout.

K) The full 23-node skeleton against a single centre-of-mass point per animal, both arms
from the same com3d_used source: centroid-only input matches the keypoints, pooled 0.992
against 0.985 at sigma = 0.

L) Switch rate per 100k frames against camera count: the sigma = 3 px arm is flat, while
25% instance dropout costs 130 to 190 per 100k at two cameras and 4.2 to 9.3 at six.

M) Switch rate per 100k camera-frames along the noise and dropout axes: the pooled rate
rises from 0.04 to 0.09 at sigma = 0 to 1.5, 3.3 and 6.6 at sigma = 20, passing this
configuration's measured 0.92 per 100k on real Mouse-Dyad-10M detections.

A uses the 50 Mouse-Dyad-10M sessions (5 cameras, 2 mice) and is the only fresh-anchor panel;
B to F use all 74 SLAP-2M sessions (6 proofread cameras, 1 to 4 animals) in the previous
default configuration; G to M use the 41 social-DANNCE sessions with the shipped
configuration throughout.

S3) Supplementary; not placed in the composite. Within-view IDF1 of the three trackers
by SLAP-2M difficulty: the order LUC3D, SLEAP, ByteTrack holds in all seven strata,
falling from 1.00, 1.00 and 0.95 at rating 1 to 0.36, 0.31 and 0.18 at rating 7.

S4) Supplementary; not placed in the composite. ID accuracy on the 50 Mouse-Dyad-10M sessions
(IDA = idtp / num_matches): the fresh anchor pools to 92.46% with a session median of
100.0%, against the previous default's 80.56% and 84.0%.
