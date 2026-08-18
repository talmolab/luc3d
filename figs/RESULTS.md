# Results

What each figure shows and what follows from it. Legends are in FIGURE-LEGENDS.md and
procedures in METHODS.md.

## A browser-based tool resolves one identity per animal in every camera

Multi-camera pose recording poses two problems, one within each camera and one across
them. Figure 1A shows one such recording setup: the SLAP-2M cage, its eight cameras and
two animals, rendered from a single session's own calibration and tracked 3D poses. The
first problem, finding the keypoints in each view, is solved by existing detectors. The
second, deciding which detection in one view is the same animal as which detection in
another, has no standard tool, and until it is solved there is no 3D reconstruction and
nothing to proofread.

LUC3D addresses the cross-camera problem in a web browser, with no installation and no
build step (Figure 1B). It contributes three stages: cross-view re-identification,
triangulation, and proofreading of the resulting 3D. The per-view detector comes from
elsewhere; the application consumes SLEAP predictions.

Figure 1C shows the operation on a single frame of an eight-camera recording of three
mice. The detector supplies 25 detections across the eight views, carrying 21 distinct
track names, and those names are per camera and arbitrary: the same animal is track 89
in one view and track 83 in another. After re-identification the frame holds three
identities, one per animal in every view, with 24 of the 25 detections assigned. The
one left over is a duplicate detection of an already-matched animal in a view the panel
does not show, which one-to-one assignment correctly refuses. Figure 1D triangulates
that frame and fills all 45 of its 3D keypoints, placing the reconstruction at one
camera's own pose and field of view so that it can be compared directly against that
camera's video.

Figure 1E places the tool among seven existing packages. Reprojection-aided labelling
predates this work: Label3D and JARVIS both provide it. No other tool in the table
combines annotation-time cross-view identity, multi-animal support, a 3D proofreading
viewport, and running in a browser without installation.

## Two labelled views are enough, because the reprojection into the rest is usually already correct

Manual multi-camera annotation scales with the number of cameras. A labeller places
every keypoint in every view, so the cost of a frame grows with the rig. If the 3D
point can be solved from two views, the remaining views can be filled by reprojection,
and the labeller only has to correct those reprojections that land badly. The saving is
therefore governed by one measurable quantity: the fraction of reprojections that a
labeller would reject.

That fraction was measured on every frame of all 56 sessions, 286,200,174 keypoints
from 9 mice in 18 pairings (Figure 2C). A 3D point solved from two views and projected into a
view that was not labelled lands a median 4.27 px from that view's own detection,
pooled over every frame, with 94.6 per cent of reprojections within 10 px and 99.6 per
cent within 20 px, so at a 10 px acceptance tolerance only 5.5 per cent need touching
at all. The reference here is the
detector's output in the held-out view rather than a human label, so this measures
agreement with a detector; whether an annotator would accept the same reprojections is
a separate, untested question.

Figure 2B turns that fraction into placements per animal per frame. On the measured
five-camera rig, accepting reprojections at 10 px reduces manual placements from 75 to
32, a 2.3-fold saving, and the saving grows with rig size because the labelled two views
stay fixed while the reprojected remainder does not. Only one rig size was measured, so
every other point on that panel is the model rather than a measurement, and the panel
draws it that way.

The cost of solving from only two views is geometric, and Figure 2D shows it directly.
The error of a two-anchor solve is set by the angle the anchor pair subtends at the
animal and follows the depth-uncertainty relation k over sine theta with k equal to
1.52 mm, so the practical advice is to label two views that are far apart. The
narrowest pair on this rig, at 13 degrees, gives 12.6 mm of error while the widest, at
31 degrees, gives 2.7 mm, against a floor of 1.2 mm when all five views contribute.

## A greedy per-camera assignment matches exhaustive enumeration at a millionth of the cost

The published approach to annotation-time cross-view association enumerates every
possible grouping of detections into identities, triangulates and reprojects each, and
keeps the grouping with the lowest reprojection error. That is A factorial per view and
therefore A factorial raised to the power C per frame: 32 hypotheses for two animals in
five cameras and 190 million for four animals in six (Figure 3B). LUC3D instead
solves one assignment problem per camera and commits it before moving to the next, at a
cost of C times A cubed (Figure 3A).

The question is whether the cheap procedure gives up accuracy. Figure 3C answers it
against proofread ground truth rather than against the other method, over 92 sessions:
every session that has both pool detections and proofread ground truth. The panel draws
the greedy grouping at the fresh-anchor operating point, the shipped configuration
(Methods). On the 4,591,725 frames where exhaustive enumeration could be run and the
result scored against ground truth, that grouping differs from ground truth on 940
frames and the exhaustive optimum on 1,453, that is 2.05 against 3.16 per 10,000. On
the 672 frames where the two methods choose different groupings, ground truth agrees
with the greedy choice on 592 of them and with exhaustive on 79. The previous default
misgroups 1,077 frames, 2.35 per 10,000; it differs from exhaustive on 809 frames, and
ground truth sides with its greedy choice on 592 of those against 216. Optimising the
reprojection objective harder does not buy accuracy here, because the objective itself
is what runs out: the lowest-reprojection-error grouping is not always the correct
grouping.

Figure 3E prices the two procedures on identical detections. The gap is a factor of
about a million in the four-animal, six-camera configuration, which exhaustive
enumeration could not run at all. That point is drawn as a bound rather than a
measurement, and the bound is generous to the published method twice over: it removes a
relabelling symmetry that method does not exploit, and it prices the remainder at the
cheapest rate measured anywhere in the sweep. Even so, one second of 30 fps video would
cost 16.5 hours.

Two limits belong with this result. Exhaustive enumeration is undefined unless every
camera holds exactly as many detections as there are animals, so it was run only on the
47.4 per cent of frames that satisfy that, 4,591,864 of 9,678,503, and the excluded
frames are the occluded ones, which is to say exactly the frames association finds
hardest. And 94.2 per cent of the computed frames are the easiest configuration, two
animals in five cameras. Agreement
between the two methods falls monotonically as animals are added, from 99.996 per cent
at two animals in five cameras to 99.038 per cent at four animals in three, a trend the
earlier four-session version of this benchmark could not have shown. The equivalence
therefore holds where the published method can run, and is not a claim about the frames
where it cannot.

Figure 3D asks what the three-dimensional term in the association cost contributes, by
sweeping its weight against the two-dimensional term's over all 50 Mouse-Dyad-10M sessions, in
the same fresh-anchor configuration as Figure 3C. The two weights matter only through
their ratio, a fact verified on an earlier eight-session grid where all 24 weight
combinations collapsed onto it, so the sweep samples the ratio directly. The term is
necessary. The association does not survive without it: with the term switched off
entirely, identity switches run at 632 per 100,000 camera-frames and cross-view IDF1
falls to 0.599. At the app default ratio of six the arm holds 413 switches, 0.92 per
100,000, at IDF1 0.8613, and doubling the ratio to twelve buys 42 fewer switches and no
IDF1 (0.8614 against 0.8613). The previous default, swept over the same sessions and
kept in the deposit, holds 2,071 switches at IDF1 0.7493 at the same ratio. Rates are
over the 45,021,960 camera-frames of the 50 sessions. The default ratio is a safe
choice rather than one this sweep selected, and the figure marks it as the default and
nothing more.

## Triangulation accuracy is set by geometry, not by the solver

Having established the correspondence, the remaining question is what governs the
accuracy of the resulting 3D point. Figure 4 separates three candidates: the number of
contributing views, the treatment of a view that disagrees, and the choice of solver.

View count dominates. Of the three candidates, the number of contributing views moves
the error most. Scored in a camera the solve never saw, error falls from 4.32 px with
two cameras to 3.34 px with four (Figure 4B). Rejecting a disagreeing view matters on
the tail rather than in the bulk: when the worst-fitting view sat more than 10 px from
the all-view solution, dropping it moves the 3D point by a median 7.2 mm, against 1.1 mm
when that view was already within 3 px. Those large corrections are 1.6 per cent of
keypoints, so the 7.2 mm describes a small and identifiable minority rather than
typical behaviour. Figure 4C scores the drop in the views that are kept, where the
error falls from 2.06 to 1.71 px in 50 of 50 sessions; because the dropped view leaves
the scoring along with the solve, a fall is guaranteed by construction, and what the
panel measures is the size of the effect rather than its existence.

The solver, by contrast, barely matters. Across four solvers, two from this work and
two from aniposelib, the entire spread on a held-out camera is 3.11 to 3.34 px (Figure
4D). Neither library's non-linear refinement earns its cost out of sample, and
aniposelib's linear solve is the lowest of the four. We report that plainly: LUC3D's
solvers are 4.6 and 5.2 times faster than the corresponding aniposelib paths
(Figure 4E), a speed result and nothing more.

Two measurement decisions carry this figure. Scoring happens in a camera excluded from
the solve, because the refinement minimises reprojection error in the cameras it was
given, so any metric computed on those cameras is one the method optimises. And solvers
are not ranked by distance to the proofread reconstruction, because that metric cannot rank
solvers at all: the refinement moves the estimate in a direction essentially
uncorrelated with the direction to the reference, and adding a displacement orthogonal
to an existing error always increases the distance, so the metric would report that the
refinement had moved regardless of whether it improved.

## Cross-view identity makes a social behaviour measurable that no single camera can see

The preceding figures are about the tool. Figure 5 asks what the tool is for, by
measuring a behaviour that only exists once the 3D is available.

Rearing is defined by height above the floor, and a pair interaction by the distance
between two animals. Neither quantity exists in a single camera view. In the example
display of Figure 5A every camera sits between 58 and 76 degrees above the animals, and
in every one of the five views the two noses sit 2.7 to 6.0 px apart while the tail
bases sit 93 to 106 px apart, so no view recovers the vertical and no view turns those
pixel gaps into a distance between the animals.

Rearing in these pairs is coupled, and the coupling requires proximity (Figure 5G).
Taking every rearing onset by one animal and reading out whether the other is rearing,
the probability is 2.9 times chance at the onset itself and peaks at 4.1 times half a
second later, which is about the time it takes a mouse to get up. When the animals are
more than two body lengths apart the same measurement is flat at 1.05, and a
circular-shift null that preserves each animal's rearing rate, bout structure and
autocorrelation is flat at 0.99. The second animal is responding to the first rather
than coinciding with it, and the proximity split rules out a shared external drive. The
same measurement on the two-animal sessions of SLAP-2M gives 1.08 within two body
lengths and 0.97 beyond, that is no coupling at all. Arena size is the likely reason,
since SLAP-2M's arena is 3.2 body lengths across against Mouse-Dyad-10M's 6.9 so its two
conditions barely differ, but that explanation is untested and the claim is made
for Mouse-Dyad-10M alone.

That coupling defines an event, hereafter referred to as a display: both animals
reared, within two body lengths, held for at least a quarter of a second. There are 539
such displays in 37 of the 56 sessions. They are brief and still. The animals hold the
posture for a median 0.71 s while moving at 0.44 times their own baseline speed, with
94 per cent of displays below baseline (Figure 5E). A mutual upright posture at close
range is the classic agonistic configuration, and the obvious description would be
boxing. Animals moving at four tenths of their usual speed are not fighting, so we call
it an upright display and go no further, since what the behaviour means cannot be
settled by kinematics.

The display is not symmetric. One animal is up a median 0.37 s before the other joins
(Figure 5C). At this recording rate that is 56 frames, and 11 frames at 30 fps; the
shorter lags in the distribution, down at the 0.16 s quartile, are where the high frame
rate earns its keep. Within a session, one animal starts
most of the displays: pooled over all 539 displays, the session's leader starts 80 per
cent of them, and that figure is stable at every session-inclusion threshold tested
(Figure 5F). Because the leader's share is by construction the larger of two shares, it
cannot fall below one half, so the panel draws the distribution a fair coin would
produce at each session size; 16 of the 24 sessions with at least five displays exceed
it. Pooled over the same session sizes, that fair coin expects a leader share of 59.1
per cent, so the pooled comparison is 80 against 59 rather than 80 against 50.

The 56 Mouse-Dyad-10M sessions are repeated recordings of 9 mice in 18 pairings rather than 56
independent samples, so the analysis was repeated with the pair as the unit of
replication. Aggregating each pair's sessions into a single observation leaves 14 pairs
with at least five displays, covering 536 displays. The leading member starts a median
0.81 of that pair's displays, the same member leads in all 14 of 14 pairs (sign test
P = 1.2 x 10 to the minus 4), and pooling over pairs gives 429 of 536 displays, 80.0 per
cent (the figure the session-level pooling gives). The asymmetry is a property
of the pair rather than of any one recording of it.

Three controls test the obvious alternatives. The leader is not simply the animal
that rears more, since a session's initiation share is uncorrelated with its share of
rearing time (r = -0.012, P = 0.96 over 24 sessions). It is not an artefact of the
per-animal height threshold, since an absolute 60 mm threshold shared by both animals
returns the same leader in all 24 sessions, and a single shared per-pair threshold in
22 of 24. Body size is not independent of leadership, and the direction deserves
stating: the leader is the shorter animal in 28 of the 36 sessions with a unique leader
(sign test P = 0.0012). Even so, the asymmetry itself does not require it: within the same
24-session family as the tests above, the three sessions where the leader is the
longer animal still hand it 75 of 97 displays, 77 per cent (binomial
P = 6 x 10 to the minus 8), and over all sessions with any known initiator the
count is 81 of 103. What the data support is an
asymmetry that is stable within a session, and no claim is made about dominance, for
which no assay was run.

## Session difficulty removes keypoints rather than degrading them

One question comes before any tracker comparison: what varies across a corpus. Each of
the 74 SLAP-2M sessions, which is the whole corpus, carries a curator-assigned
difficulty rating, and
Figure 6C separates that rating's effect into two quantities that behave differently.
From the easiest stratum to the hardest, measured on every frame of all 74 sessions
(187,134,382 keypoint comparisons), the per-view miss rate rises 10.8-fold, from 5.3 to
57.7 per cent, while the mean error of the detections that do fire rises only 1.30-fold,
from 3.65 to 4.74 px.

That asymmetry is favourable for multi-camera work, and it is the reason a multi-camera
pipeline degrades gracefully. A keypoint missing in one view is recoverable from the
others; a keypoint present but wrong in every view is not. Difficulty, as this corpus
scores it, mostly produces the recoverable kind.

Figure 6D controls for the obvious confound, that difficulty tracks the number of
animals, by re-running the same measurement within each animal count. The relationship
survives, and the marginal miss rate by animal count alone is not even monotone, since
it falls at four animals.

## Only cross-view identity survives being pooled across cameras

Figure 7 compares LUC3D against per-camera trackers on identical, identity-stripped
detections, so that what is compared is association rather than detection.

Within a single camera, all three methods are broadly competitive, and LUC3D's
advantage over SLEAP is largest in the single-animal sessions where there is nothing to
associate (Figure 7C). Pooled over all 74 sessions the difference in within-view IDF1
is 0.091 in LUC3D's favour (55 of 74 sessions, sign test P = 3.4 x 10 to the minus 5).
Restricted to sessions with two or more animals it is 0.052, ahead in 30 of 42 sessions
(P = 0.008), and in the two cells where cross-view association ought to help most,
three and four animals, it is slightly negative, with SLEAP ahead in all seven of those
sessions. We state that rather than pooling it away.

The difference appears when identities are pooled across cameras (Figure 7A). Scoring
all five cameras into one accumulator with a single global identity per animal, LUC3D's
IDF1 is unchanged, 0.861 within view and 0.861 across at the fresh-anchor configuration
the panel draws, and 0.749 to 0.749 for the previous default kept in the deposit. The
per-camera trackers lose about three quarters or more of theirs, 0.642 to 0.146 and
0.676 to 0.157, a retention of 0.23. This is close to arithmetic rather than a contest,
and we do not present it as a benchmark
win: a tracker that labels each camera independently can have its labelling matched to
the truth in at most one camera, so 1 over C is a ceiling for such a method, and the
comparison scores those methods on a capability they never claimed. What the comparison
establishes is that the capability is absent; it does not show the methods to be poor.
Per-camera identity and cross-view identity are different objects, and only the latter
supports a 3D reconstruction or a proofreading pass that acts on all views at once.

There is a cost, and Figure 7F reports it. LUC3D fragments tracks more than SLEAP does,
by a mean of 6.2 fragmentations per camera-session and a median of 1.3, and SLEAP
fragments less in 72 of the 74 sessions. A fragmentation differs from an identity switch: the track breaks and
is later resumed rather than being handed to the wrong animal. For a proofreading tool
that is the preferable failure, since a break is visible and locally repairable while a
switch propagates silently, but it is a real cost and it is the price of the same
conservatism that produces the cross-view result.

## The tracker transfers to another laboratory's rats without re-tuning

Every result so far is measured on the two corpora the tool was built against, on mice,
with a 15-node skeleton. Figure 7G to 7M ask whether any of it survives contact with
data from elsewhere. The test uses three dataset families from the published
social-DANNCE deposit: 6 TRIADS sessions of 3 male rats, 6 BEDDING sessions of 2 female
rats, and 29 SCN2A dyad sessions, 41 sessions in all, each recorded by 6 calibrated
cameras and carrying its own proofread 3D tracks. Different species, different body
size, different rig, different laboratory, and a 23-node skeleton rather than 15. No
parameter of the tracker was changed, and an audit of the constructed tracker's
effective settings under the exact scored seeds confirms it on all four dataset groups.

Per-view detections are synthesized by reprojecting the deposit's own 3D tracks through
its own calibrations, then shuffling instance slots independently in every frame and
every view. The shuffle is what makes the test a test: slot order carries no information
across views or through time, so the tracker must rebuild grouping and identity from
geometry alone. Because reprojections of one consistent 3D source agree exactly at zero
noise, the noiseless cell is a ceiling by construction and proves nothing on its own,
which is why the result is reported as a surface over controlled corruptions rather than
as a single number. Three controls establish that the score cannot be earned any other
way: randomized ground truth collapses to chance at IDF1 0.5001, a mid-session
ground-truth splice is caught at exactly 0.5 with exactly one swap event, and running
the same detections through deliberately rotated calibrations collapses to 0.513 with
1,075 switches in 20,000 frames.

The tracker holds. Under pixel noise the median session stays at IDF1 1.0 through
sigma = 5 px in every dataset, and the pooled detection-weighted score stays at or above
0.96 across the same range, falling to 0.98, 0.88 and 0.94 for TRIADS, BEDDING and SCN2A
only at sigma = 20 px. At sigma = 0, 36 of the 41 sessions complete with zero identity
switches, and those 36 sessions hold 3.06M tracked frames including 68,560 frames with
the animals' centroids within 50 mm of each other, 22.9 minutes of close contact. The
five remaining sessions contain exactly one swap event each. Every large noiseless loss
traces to one persistent swap seeded where the deposit's own 3D tracks pass within a few
millimetres, 2.96 mm in the worst TRIADS session and 5.87 mm in the worst SCN2A session.
Where the source tracks momentarily coincide no geometric method can decide identity,
and several sessions with sub-6 mm approaches still score 1.0. The failures are isolated
events at near-coincident tracks rather than accumulating drift.

Camera count matters less than expected, and missing detections matter more. At working
noise with no dropout the switch rate is essentially flat in the number of cameras, at
or below about 1.1 per 100k for TRIADS and BEDDING at every count down to an opposite
pair. Under 25% instance dropout the redundancy curve appears: about 130 to 190 per 100k
at two cameras, where a dropped detection leaves an animal below the two views
triangulation needs, falling to roughly 4.2 to 9.3 at six. Pixel noise barely engages
camera count; missing detections are what camera redundancy exists to absorb.

One expectation did not survive the benchmark. Comparing the full 23-node skeleton
against a single centroid per animal appeared at first to show that skeletons carry
identity and centroids do not, with mean IDF1 deficits from 0.02 to 0.22 by dataset.
That comparison was drawing its centroids for TRIADS and SCN2A from the deposit's
separate COM-network directory, whose instance indices come from the COM tracker rather
than from the sDANNCE tracker supplying the keypoint arm, so the two arms were scored
against different ground truths and the deficit measured the disagreement between two
annotations rather than any property of the input. Re-running both arms from the same
centroids the sDANNCE pass itself consumed removes it. Centroid-only input then tracks
essentially as well as the full skeleton, pooled 0.992 against 0.985 at sigma = 0 and
0.991 against 0.967 at sigma = 3, with per-dataset gaps inside 0.04 of zero and pooled
switch rates falling from 1.97 to 0.01 per 100k in the SCN2A first round. BEDDING, which
publishes no COM directory and had always used the matched source, reproduces its
earlier values bit-exactly on all six sessions, which is what confirms the substitution
changed provenance and nothing else. What the corrected ablation establishes is that
six calibrated views are sufficient on their own: the tracker holds identity from a
single point per animal, and the remaining 22 nodes add nothing it needs for that. The
scope is worth stating, since the detections here are reprojections of a proofread 3D
source and the rig is a full six cameras; whether centroids remain sufficient against
real detector error, or at the two- and three-camera counts of Figure 7L, is not tested.

## What these results do and do not establish

Every measurement here is of mice, a 15-node skeleton, and one of two camera rigs, from
two laboratories. Those limits belong to the evidence rather than to the tool, and
claims of generality should be read at that scope. Two results already differ between
the corpora: the rearing coupling is 2.9-fold on Mouse-Dyad-10M and 1.08-fold on SLAP-2M,
which we attribute to arena size without testing it, and the within-view tracking
advantage over SLEAP is largest in the single-animal sessions and reverses in the
three- and four-animal cells.

Several comparisons rest on smaller samples than their absolute numbers suggest, and we
state the denominators rather than the numerators. The association head-to-head in
Figure 3 is limited to the frames on which the exhaustive method is defined at all,
which excludes the occluded frames that association finds hardest. The labelling saving
in Figure 2 is a model evaluated at one measured rig size, and its acceptance fraction
is measured against a detector rather than against a human annotator, so it is a
prediction about labelling effort rather than a measurement of it; no annotator study
was run. And the behavioural asymmetry in Figure 5 rests on 9 mice in 18 pairings,
which is why it is reported at the pair level as well as at the session level, and why
no claim about dominance is made. That is the discipline the whole section applies:
every comparison is scored where it can be checked, every rate is stated with its
denominator, and every claim stops at the edge of what was measured.
