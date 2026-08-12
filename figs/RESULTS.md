# Results

What each figure shows and what follows from it. Legends are in FIGURE-LEGENDS.md and
procedures in METHODS.md.

## A browser-based tool resolves one identity per animal in every camera

Multi-camera pose recording produces a per-camera problem and a cross-camera problem.
The per-camera problem, finding the keypoints, is solved by existing detectors. The
cross-camera problem, deciding which detection in one view is the same animal as which
detection in another, has no standard tool, and until it is solved there is no 3D
reconstruction and nothing to proofread.

LUC3D addresses that problem in a web browser with no installation and no build step
(Figure 1A). The three stages it contributes are cross-view re-identification,
triangulation, and proofreading of the resulting 3D; the per-view detector is not ours,
and the application consumes SLEAP predictions.

Figure 1B shows the operation on a single frame of an eight-camera recording of three
mice. The detector supplies 24 detections across the eight views, carrying 20 distinct
track names, and those names are per camera and arbitrary: the same animal is track 89
in one view and track 83 in another. After re-identification the frame holds three
identities, one per animal in every view, with every detection assigned. Figure 1C
triangulates that frame and fills all 45 of its 3D keypoints, and shows the
reconstruction placed at one camera's own pose and field of view so that it can be
compared directly against that camera's video.

Figure 1D places the tool among seven existing packages. Reprojection-aided labelling
is not new, and Label3D and JARVIS both provide it. What no other tool in the table
combines is annotation-time cross-view identity, multi-animal support, a 3D
proofreading viewport, and running in a browser without installation.

## Two labelled views are enough, because the reprojection into the rest is usually already correct

Manual multi-camera annotation scales with the number of cameras: a labeller places
every keypoint in every view. If the 3D point can be solved from two views, the
remaining views can be filled by reprojection, and the labeller only has to correct
those reprojections that land badly. The saving is therefore governed by one measurable
quantity, the fraction of reprojections that a labeller would reject.

We measured that fraction on 50 proofread sessions of 9 mice in 18 pairings (Figure 2C).
A 3D point solved from two views and projected into a view that was not labelled lands a
median 4.32 px from that view's own detection. The reference here is the detector's
output in the held-out view rather than a human label, so this measures agreement with a
detector; whether an annotator would accept the same reprojections is a separate
question that we have not tested, with 94.6 per cent of reprojections
within 10 px and 99.68 per cent within 20 px. At a 10 px acceptance tolerance only 5.4
per cent of reprojections need touching at all.

Figure 2B turns that into placements per animal per frame. On the five-camera rig we
measured, accepting reprojections at 10 px reduces manual placements from 75 to 32, a
2.3-fold saving, and the saving grows with rig size because the labelled two views stay
fixed while the reprojected remainder does not. Only one rig size was measured, so
every other point on that panel is the model rather than a measurement, and the panel
draws it that way.

The cost of solving from only two views is geometric, and Figure 2D shows it directly.
The error of a two-anchor solve is set by the angle the anchor pair subtends at the
animal and follows the depth-uncertainty relation k over sine theta with k equal to
1.52 mm, so the practical advice is not to label two views but to label two views that
are far apart. A pair subtending 15 degrees gives roughly 12 mm of error where a pair
at 30 degrees gives under 3 mm, against a floor of 1.2 mm when all five views
contribute.

## A greedy per-camera assignment matches exhaustive enumeration at a millionth of the cost

The published approach to annotation-time cross-view association enumerates every
possible grouping of detections into identities, triangulates and reprojects each, and
keeps the grouping with the lowest reprojection error. That is A factorial per view and
therefore A factorial raised to the power C per frame, which is 32 hypotheses for two
animals in five cameras and 1.9 hundred million for four animals in six (Figure 3C).
LUC3D instead solves one assignment problem per camera and commits it before moving to
the next, which costs C times A cubed (Figure 3A).

The question is whether the cheap procedure gives up accuracy, and Figure 3D answers it
against proofread ground truth rather than against the other method, over 92 sessions:
every session that has both pool detections and proofread ground truth. On all 4,572,172
frames where exhaustive enumeration could be run at all, the greedy grouping differs
from ground truth on 1,052 frames and the exhaustive optimum on 1,309, that is 2.30
against 2.86 per 10,000. On the 642 frames where the two methods choose different
groupings, ground truth agrees with the greedy choice on 449 of them and with exhaustive
on 192. Optimising the reprojection objective harder does not buy
accuracy here, because the objective itself is what runs out: the
lowest-reprojection-error grouping is not always the correct grouping.

Figure 3F prices the two procedures on identical detections. The gap is a factor of
about a million in the four-animal, six-camera configuration, which exhaustive
enumeration could not run at all. That point is drawn as a bound rather than a
measurement, and the bound is generous to the published method twice over, since it
removes a relabelling symmetry that method does not exploit and prices the remainder at
the cheapest rate measured anywhere in the sweep. Even so, one second of 50 fps video
would cost more than a day.

Two limits belong with this result. Exhaustive enumeration is undefined unless every
camera holds exactly as many detections as there are animals, so it was run only on the
69 per cent of frames that satisfy that, and the excluded frames are the occluded ones,
which is to say exactly the frames association finds hardest. And 94.6 per cent of the
computed frames are the easiest configuration, two animals in five cameras. Agreement
between the two methods falls monotonically as animals are added, from 99.996 per cent
at two animals in five cameras to 99.000 per cent at four animals in three, a trend the
earlier four-session version of this benchmark could not have shown. The
equivalence therefore holds where the published method can run, and is not a claim
about the frames where it cannot.

Figure 3E asks what the three-dimensional term in the association cost contributes, by
sweeping it against the two-dimensional term over 24 combinations on eight complete
sessions. The two weights turn out to matter only through their ratio: every pair of
combinations sharing a ratio returns identical scores. The term is necessary. With it
switched off entirely, identity switches run at 5.69 per 1,000 camera-frames and
cross-view IDF1 falls to 0.595. Bringing the term up to parity with the two-dimensional
one removes 98 per cent of those switches, leaving 0.097 per 1,000, and lifts IDF1 to
0.750. Beyond parity the two metrics behave differently: the switch rate continues to
fall slowly, reaching 0.038 per 1,000 at the largest weights tested, while IDF1 varies
between 0.71 and 0.76 without a clear trend. Rates are over the 7,205,370 camera-frames
of the eight sessions, and the raw counts, 40,984 falling to 272, are deposited
alongside them. The
shipped default sits in that region. It is a safe choice rather than one this sweep
selected, and the figure marks it as the default and nothing more.

## Triangulation accuracy is set by geometry, not by the solver

Having established the correspondence, the remaining question is what governs the
accuracy of the resulting 3D point. Figure 4 separates three candidates: the number of
contributing views, the treatment of a view that disagrees, and the choice of solver.

View count dominates. Scored in a camera the solve never saw, error falls from 4.32 px
with two cameras to 3.34 px with four (Figure 4B). Rejecting a disagreeing view matters
on the tail rather than in the bulk: when the worst-fitting view sat more than 10 px
from the all-view solution, dropping it moves the 3D point by a median 7.2 mm, against
1.1 mm when that view was already within 3 px (Figure 4C). Those large corrections are
1.6 per cent of keypoints, which the panel prints under the axis, so the 7.2 mm figure
describes a small and identifiable minority rather than typical behaviour.

The solver, by contrast, barely matters. Across four solvers, two from this work and
two from aniposelib, the entire spread on a held-out camera is 3.11 to 3.34 px (Figure
4D). Neither library's non-linear refinement earns its cost out of sample, and
aniposelib's linear solve is the lowest of the four. We report that plainly: our
solvers are 4.4 and 2.8 times faster than the corresponding aniposelib paths (Figure
4E), and that is a speed result, not an accuracy result.

Two measurement decisions carry this figure and are worth stating. Scoring in a camera
excluded from the solve is essential, because our refinement minimises reprojection
error in the cameras it was given, so any metric computed on those cameras is one the
method optimises. And distance to the proofread reconstruction cannot be used to rank
solvers at all: the refinement moves the estimate in a direction essentially
uncorrelated with the direction to the reference, and adding a displacement orthogonal
to an existing error always increases the distance, so that metric would report that
the refinement had moved regardless of whether it improved.

## Cross-view identity makes a social behaviour measurable that no single camera can see

The preceding figures are about the tool. Figure 5 asks what the tool is for, by
measuring a behaviour that only exists once the 3D is available.

Rearing is defined by height above the floor, and a pair interaction by the distance
between two animals. Neither quantity exists in a single camera view. In the example
display of Figure 5A every camera sits between 58 and 76 degrees above the animals, and
the two noses are 93 to 106 px apart in every one of the five views, so no view
recovers the vertical and no view distinguishes the animals' separation from their
projection.

Rearing in these pairs is coupled, and the coupling requires proximity (Figure 5G).
Taking every rearing onset by one animal and reading out whether the other is rearing,
the probability is 2.9 times chance at the onset itself and peaks at 4.1 times half a
second later, which is about the time it takes a mouse to get up. When the animals are
more than two body lengths apart the same measurement is flat at 1.05, and a
circular-shift null that preserves each animal's rearing rate, bout structure and
autocorrelation is flat at 0.99. The second animal is responding to the first rather
than coinciding with it, and a shared external drive is ruled out by the proximity
split. The same measurement on the two-animal sessions of SLAP-2M gives 1.08 within two
body lengths and 0.97 beyond, that is no coupling at all. We attribute that to arena
size, since SLAP-2M's arena is 3.2 body lengths across against BMimica's 6.9 so its two
conditions barely differ, but we have not tested the explanation and the claim is made
for BMimica alone.

That coupling defines an event: both animals reared, within two body lengths, held for
at least a quarter of a second. There are 539 such displays in 37 of the 56 sessions.
They are brief and still. The animals hold the posture for a median 0.71 s while moving
at 0.44 times their own baseline speed, with 94 per cent of displays below baseline
(Figure 5E). A mutual upright posture at close range is the classic agonistic
configuration, and the obvious description would be boxing, but animals moving at four
tenths of their usual speed are not fighting. We therefore call it an upright display
and go no further, since what the behaviour means cannot be settled by kinematics.

The display is not symmetric. One animal is up a median 0.37 s before the other joins
(Figure 5C), which is 56 frames at this recording rate and one or two frames at 30 fps,
so this measurement requires the high frame rate. Within a session, one animal starts
most of the displays: pooled over all 539 displays, the session's leader starts 80 per
cent of them, and that figure is stable at every session-inclusion threshold we tried
(Figure 5F). Because the leader's share is by construction the larger of two shares, it
cannot fall below one half, so the panel draws the distribution a fair coin would
produce at each session size; 16 of the 24 sessions with at least five displays exceed
it.

The 56 BMimica sessions are repeated recordings of 9 mice in 18 pairings rather than 56
independent samples, so we repeated the analysis with the pair as the unit of
replication. Aggregating each pair's sessions into a single observation leaves 14 pairs
with at least five displays, covering 536 displays. The leading member starts a median
0.81 of that pair's displays, the same member leads in all 14 of 14 pairs (sign test
P = 1.2 x 10 to the minus 4), and pooling over pairs gives 429 of 536 displays, 80.0 per
cent, which is the figure the session-level pooling gives. The asymmetry is a property
of the pair and not of any one recording of it.

Three controls exclude the obvious alternatives. The leader is not simply the animal
that rears more, since a session's initiation share is uncorrelated with its share of
rearing time (r = -0.012, P = 0.96 over 24 sessions). It is not an artefact of the
per-animal height threshold, since a single shared threshold returns the same leader in
22 of 24 sessions and an absolute threshold in millimetres in all 24. And it is not body
size: in the eight sessions where the initiator is the longer animal it still starts 81
of 103 displays, 79 per cent (binomial P = 4 x 10 to the minus 9). What the data
support is an asymmetry that is stable within a session, and we make no claim about
dominance, for which no assay was run.

## Session difficulty removes keypoints rather than degrading them

Before comparing trackers it is worth knowing what varies across a corpus. Each of the
74 SLAP-2M sessions, which is the whole corpus, carries a curator-assigned difficulty
rating, and Figure 6C separates that rating's effect into two quantities that behave
differently. From the easiest stratum to the hardest, measured on every frame of all 74
sessions
(187,134,382 keypoint comparisons), the per-view miss rate rises 10.8-fold, from 5.3 to
57.7 per cent, while the mean error of the detections that do fire rises only 1.30-fold,
from 3.65 to 4.74 px.

That asymmetry is favourable for multi-camera work, and it is the reason a
multi-camera pipeline degrades gracefully. A keypoint missing in one view is recoverable
from the others; a keypoint present but wrong in every view is not. Difficulty, as this
corpus scores it, mostly produces the recoverable kind.

Figure 6D controls for the obvious confound, that difficulty tracks the number of
animals, by re-running the same measurement within each animal count. The relationship
survives, and the marginal miss rate by animal count alone is not even monotone, since
it falls at four animals.

## Only cross-view identity survives being pooled across cameras

Figure 7 compares LUC3D against per-camera trackers on identical, identity-stripped
detections, so that what is compared is association rather than detection.

Within a single camera, all three methods are broadly competitive, and LUC3D's
advantage over SLEAP is carried by the single-animal sessions where there is nothing to
associate (Figure 7D). Pooled over all 74 sessions the difference in within-view IDF1
is 0.075 in our favour, but restricted to sessions with two or more animals it is 0.024
and does not clear a sign test, and in the two cells where cross-view association ought
to help most, three and four animals, it is slightly negative. We state that rather
than pooling it away.

The difference appears when identities are pooled across cameras (Figure 7A). Scoring
all five cameras into one accumulator with a single global identity per animal, LUC3D's
IDF1 is unchanged, 0.749 within view and 0.749 across, and drifts by at most 0.007 in
any of 50 sessions. The per-camera trackers lose half to three quarters of theirs.
This is close to arithmetic rather than a contest, and we do not present it as a
benchmark win: a tracker that labels each camera independently can have its labelling
matched to the truth in at most one camera, so 1 over C is a ceiling for such a method,
and the comparison scores those methods on a capability they never claimed. What it
establishes is that the capability is absent, not that the methods are poor. The result is not that per-camera trackers are
poor, but that per-camera identity is not the same object as cross-view identity, and
that only the latter supports a 3D reconstruction or a proofreading pass that acts on
all views at once.

The advantage does not depend on the animals being easy to tell apart. Under white
bedding, where contrast against the coat is reduced, LUC3D's IDF1 falls by 0.012 while
the per-camera trackers fall by 0.079 and 0.148, and the shared detector's own recall
is essentially unchanged, which locates the loss in the association rather than in the
detections (Figure 7B).

There is a cost, and Figure 7G reports it. LUC3D fragments tracks more than SLEAP does,
by a mean of 24 fragmentations per camera-session, and SLEAP fragments less in 72 of
the 74 sessions. A fragmentation is not an identity switch: the track breaks and is
later resumed rather than being handed to the wrong animal. For a proofreading tool
that is the preferable failure, since a break is visible and locally repairable while a
switch propagates silently, but it is a real cost and it is the price of the same
conservatism that produces the cross-view result.

## What these results do and do not establish

Every measurement here is of mice, a 15-node skeleton, and one of two camera rigs, from
two laboratories. The tool imposes no such limits but the evidence does, and claims of
generality should be read at that scope. Two results already differ between the corpora:
the rearing coupling is 2.9-fold on BMimica and 1.08-fold on SLAP-2M, which we attribute
to arena size without testing it, and the within-view tracking advantage over SLEAP is
carried by single-animal sessions and is null over sessions with two or more animals.

Several comparisons rest on smaller samples than their absolute numbers suggest, and we
state the denominators rather than the numerators. The association head-to-head in
Figure 3 is limited to the frames on which the exhaustive method is defined at all,
which excludes the occluded frames that association finds hardest. The labelling saving
in Figure 2 is a model evaluated at one measured rig size, and its acceptance fraction is
measured against a detector rather than against a human annotator, so it is a prediction
about labelling effort and not a measurement of it; no annotator study was run. And the
behavioural asymmetry in Figure 5 rests on 9 mice in 18 pairings, which is why it is
reported at the pair level as well as at the session level, and why no claim about
dominance is made.
