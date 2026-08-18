# Methods

Procedures behind the measurements in Figs 1 to 7. Legends are in FIGURE-LEGENDS.md.
The script behind each panel is in PANEL-SOURCES.md.

## Corpora

Three multi-camera recordings were used. No animal procedures were performed for this
work, and all three recordings are pre-existing datasets that had already been
proofread in 3D.

The BMimica corpus consists of 56 sessions, each recording two mice with five
synchronised cameras at 150 frames per second for approximately 20 minutes, giving
10,084,734 frames in total. The 56 sessions record 9 individual mice in 18 distinct
pairings, so a session is a repeated recording of a pair rather than an independent
sample, and each pair contributes between one and six sessions. Every analysis that
treats the session as the unit of replication is therefore reported here alongside the
same analysis with the pair as the unit. A 15-node mouse skeleton was used throughout,
comprising the nose, left and right ears, the tail-tip and tail base (denoted TTI),
three intermediate tail nodes, the head, trunk and neck, and the left and right
shoulders and haunches. Figures 2, 5 and 7A, and Figure 3's two-animal five-camera
configuration and weight sweep, were measured on this corpus.

The SLAP-2M corpus consists of 74 sessions recording one to four animals with eight
cameras at 50 frames per second, giving 1,954,440 frames; six of the eight cameras are
proofread and every SLAP-2M measurement reported here uses those six. All 74 sessions
carry a proofread 3D reconstruction. The animal composition is 32 sessions with one
animal, 35 with two, 4 with three and 3 with four, giving 126 animal-sessions in total,
of which 46 are white, 42 agouti and 38 black by coat colour. Individual animal
identities are not recorded in the released metadata, so the number of distinct mice
contributing to this corpus cannot be stated from the data itself, and the session is
the unit of analysis for every SLAP-2M measurement. Each session also carries a
curator-assigned difficulty rating from 1 to 7 (12, 13, 9, 13, 10, 4 and 13 sessions
respectively) and a black or white bedding label (44 and 30 sessions), which were used
as strata in Figure 6. A bedding comparison formerly in Figure 7 was removed from the
artwork: the detector's training data are overwhelmingly black-background, so the
white-bedding arm confounds tracking with out-of-distribution detection and the
invariance claim cannot be defended; the panel and its table still regenerate.
Figures 6 and 7B to 7F, and the 2 x 6, 3 x 5 and 4 x 3 configurations of Figure 3,
were measured on this corpus.

The third recording, HardFight, is a single session recording three mice with eight
cameras at 60 frames per second, from which a 300-frame window was taken for Figure 1
and Figure 2A.
It is the only recording that was built as a complete application session with its own
calibration, which is why the panels driven through the application itself use it.

## Camera calibration

Each rig ships a calibration file that gives, for every camera, its intrinsic matrix,
its radial and tangential distortion coefficients and its extrinsic pose, in a TOML
format compatible with aniposelib. The application reads these files unchanged, and no
recalibration was performed for this work. Reprojection errors are reported throughout
in each camera's own native, still-distorted pixels, because that is the space in which
an annotator sees the error; a point is undistorted into ideal-pinhole coordinates only
inside the linear solver, and the residual is measured after it is projected back. All
3D coordinates are expressed in the calibration's own metric frame, in millimetres. For
Figure 5A the reconstructed pose was aligned to the calibration frame by a
RANSAC-Procrustes fit, which retained 98.3 per cent of correspondences as inliers and
left a residual of 1.32 mm.

## Two-dimensional detection pool

Every benchmark reported here was run on a single shared detection pool from which all
track and identity information had been removed, so that the comparisons isolate
cross-view association and triangulation from the quality of the underlying detector.
Each method under comparison received byte-identical input. Ground-truth identities were
transferred onto that pool by matching detections to the proofread instances frame by
frame and camera by camera at an intersection-over-union threshold of 0.5, so that a
detector identity swap appears in the results as an error of the method under test
rather than being silently absorbed. Detections were produced by SLEAP; the application
consumes SLEAP .slp files and neither trains nor runs a detector of its own.

The measurements divide into two kinds, and they treat the recordings differently. The
association and tracking results in Figures 3 and 7, and the behavioural analysis in
Figure 5, were computed on complete sessions, every frame, with no subsampling. The
per-keypoint geometric measurements in Figures 2, 4 and 6 were computed on a uniform
sample of frames, every 15th frame for Figure 4; Figures 2 and 6 use every frame,
except that Figure 2C is drawn from Figure 4's by-camera-count measurement pass —
the k-view solves and their held-out scorings — and therefore carries Figure 4's
sampling and its 50 proofread sessions. The sample is uniform and
was never selected on any property of the data, and it is large in absolute terms:
286,200,174 keypoints in Figure 2, 17,013,412 in Figure 4, and 187,134,382 keypoint
comparisons in Figure 6. Subsampling was necessary because these measurements are
per-keypoint and combinatorial in the cameras. Figure 2 alone rests on 12,774,240
two-anchor solves and 38,322,720 held-out view measurements at its sampled density, and
Figure 4B on 55,298,204 solves, so measuring at every frame would multiply those figures
by two orders of magnitude. The sampled density was checked
against a denser one rather than assumed to be sufficient. Repeating the Figure 2
measurement on three sessions at every 20th frame instead of every 200th, a tenfold
increase to 264,525 keypoints per session, moves every reported quantity by less than
one per cent: the median held-out error changes by 0.31 per cent, its 90th percentile
by 0.60 per cent, the fraction of reprojections within 5 px by 0.16 per cent, and the
3D error at two, three and four anchors by 0.29, 0.52 and 0.77 per cent. Two
independent samplings of a further quantity agree to the same tolerance: the 3D error
by anchor count computed for Figure 4B at every 240th frame reproduces the same
quantity computed for Figure 2 at every 200th frame to within 0.1 to 0.7 per cent at
every camera count. This is the expected result for these recordings, since at 150
frames per second an animal moves well under a millimetre between consecutive frames,
so a stride of 200 samples the behaviour every 1.3 s and discards redundancy rather
than information. The one place where the stride interacts with a method rather than
merely with the sample size is temporal smoothing, and that is the reason the smoothing
term in the comparison triangulator was disabled, as described below.

## Cross-view association

For each frame the application maintains a set of 3D targets and solves one Hungarian
assignment per camera, committing each camera's assignment to the target set before the
next camera is solved, which costs O(C·A³) for A animals and C cameras. The cost of
pairing a target t with a detection d is summed over the skeleton nodes k with per-node
weights w_k, where a weight of zero removes that node from the association entirely, and
the sum is negated so that the solver minimises it. The cost has two terms, stated here
in full as implemented (pose/cross-view-tracker.js) since no panel now carries them. The
two-dimensional term compares the detection with the target's projection pi(t) into that
camera, in undistorted ideal-pinhole (normalised) coordinates, and decays with the age
of the target:

    w_k · corr2d · (1 − |d_k − pi(t)_k| / (velThresh · (1 + Δt))) · e^(−λ·Δt)

where Δt is the target's age — the detection's frame index minus the mean frame index of
the detections fused into the target — and λ is the time penalty, so age acts twice:
the distance allowance grows with (1 + Δt) while the whole term decays exponentially.
The three-dimensional term is on the perpendicular distance from the target's 3D point
to the ray back-projected from the detection, computed from the bare extrinsic matrix,
with no age decay (the reference implementation fixes Δt = 0 here):

    w_k · corr3d · (1 − dist(t_k, ray(d_k)) / distThresh)

Both thresholds are soft, in the sense that exceeding one drives its term negative
rather than preventing the pairing outright. The shipped defaults are corr2d = 1.0 and
corr3d = 6.0 — the ratio r = corr3d/corr2d = 6 marked in Figure 3D — with
velocityThreshold 10, distanceThreshold 50 and timePenalty 0.1.

The fresh-anchor configuration that appears in Figures 3C, 3D and 7A is the same
tracker at a different operating point, run through the benchmark harness rather than
the application: per-view detections older than 20 frames expire from a target's 3D
anchor instead of being fused indefinitely, the anchor is updated synchronously, and
the 3D distance normaliser is 25 rather than 50, with the cost weights unchanged. It
is experimental — the configuration is not in the shipped application — and every
panel that carries it labels it so.

The alternative method compared against in Figure 3 is our reimplementation of the
published per-frame procedure of Maree et al. (2024) rather than the authors' own code.
It enumerates every grouping of detections into identities, of which there are (A!)^C
per frame, triangulates and reprojects each one, and keeps the grouping with the lowest
reprojection error. That procedure is undefined on any frame where a camera does not hold
exactly A detections, so a frame was treated as eligible only when every camera held
exactly A, and ineligible frames were counted and reported rather than dropped. The
benchmark covers 92 sessions, being every session that has both pool detections and
proofread ground truth: 50 of the 56 BMimica sessions, and all 35 two-animal, 4
three-animal and 3 four-animal SLAP-2M sessions. Of the 9,678,503 frames considered,
4,591,864 were eligible, 5,086,639 were skipped, and every eligible frame was
computed. An earlier pass had capped the two most expensive configurations at 2,000
eligible frames per session at three animals and 1,000 at four; the caps were
removed, and the full 10,419 eligible three-animal five-camera frames and 19,135
four-animal three-camera frames were enumerated, at a measured 2.7 and 5.5 seconds
per frame (7.8 and 29.1 core-hours for the two configurations) against 11 to 16
milliseconds per frame in the two-animal configurations. The harness
caps enumeration at one million hypotheses per frame, and the configuration of four
animals in six cameras exceeds that cap by a factor of 191, so no frames of it were
computed at all. Its cost in Figure 3E is therefore an arithmetic lower bound rather
than a measurement: the marker takes the number of distinct hypotheses that remain
after the A!-fold global relabelling symmetry is removed, (A!)^(C-1) = 7,962,624, and
prices them at the cheapest per-hypothesis rate measured anywhere in the sweep, 249
microseconds, about 0.55 hours per frame; the bar runs up to the as-published count,
(A!)^C = 191,102,976, at the 396 microseconds per hypothesis measured at the largest
configuration that did run, about 21.0 hours per frame. It is drawn with the
open-marker convention this figure uses for a quantity that was not run.

Grouping quality in Figure 3C was scored by comparing partitions rather than labels.
The grouping each method produced was compared with the ground-truth partition of the
same matched detections, and a frame was counted as misgrouped when the two partitions
differed, so that a consistent relabelling of the identities is not counted as an error.
The agreement rate between the two methods is the same comparison made between their
own outputs, pooled over frames, and is defined only on the frames exhaustive computed.
The ground-truth comparison in Figure 3C covers the same full computation: 4,591,725
of the 4,591,864 computed frames carry a transferred ground-truth match and are
scored.
Two scoring conventions separate the methods and both are disclosed. First, exhaustive
enumeration is a pure per-frame procedure with no cross-frame identity mechanism; to
make the IDF1 and switch-count reference levels in Figure 3D computable for it at all,
the harness threads identity between consecutive computed frames by nearest-3D-centroid
Hungarian matching. That threading is scaffolding added by this benchmark, not part of
the published method, so the like-for-like comparison between the methods is the
per-frame agreement rate, and any identity metric quoted for exhaustive describes the
method plus the scaffolding. Second, the two methods are scored over different
exposures: exhaustive only runs on clean frames, so its switch rate in Figure 3D is
over its own denominator, the 21,622,345 clean camera-frames it computed on the 50
BMimica sessions, while the greedy arms in the same panel are tracked and scored over
whole sessions, 45,021,960 camera-frames; the two rates are labelled with their own
denominators and are not directly comparable to one another as totals.

The weight ablation in Figure 3D was established in two passes. A 24-cell grid — a
three-dimensional weight from 0, 0.5, 1, 2, 4, 6, 8 and 12 crossed with a
two-dimensional weight from 0.5, 1 and 2, every other threshold at its default — was
run on eight complete BMimica sessions with identical detections, and cells that share
a ratio of the two weights return identical IDF1 values and identical switch counts;
this collapse was verified rather than assumed, which is why the panel plots the ratio
rather than the two weights separately. The manuscript sweep then samples each of the
twelve ratios once, at corr2d = 1, over all 50 BMimica sessions at full length, for
both the shipped tracker and the fresh-anchor configuration; the panel draws the
fresh-anchor arm against the exhaustive reference and the shipped arm is deposited.
Switch counts are reported as a rate per 100,000 camera-frames rather than as a total,
because a total is uninterpretable without its denominator; the denominator,
45,021,960 camera-frames, is taken per camera and session from the same frame counts
the scorer uses, is checked identical between the two arms before they are drawn on
one axis, and both the rate and the raw count are deposited.

## Camera-subset identity

How many cameras identity needs was measured by re-running the shipped tracker on
camera subsets of the BMimica rig: k = 2, 3 and 4 cameras with three fixed subsets per
k, plus k = 5, the full rig, over the same 50 sessions and the same shared detections.
The subsets are deterministic: the C-choose-k combinations of the five camera serials
are sorted and taken at the first, middle and last index, with no random draw, so the
run is reproducible from the script alone, and the same three subsets are used for
every session, so between-session spread is not confounded with between-subset spread
(the full 26-subset design at 50 sessions, 1,300 runs, was ruled infeasible). The
k = 5 cell is not re-tracked: it is required to reproduce the shipped tracker's
deposited 50-session numbers exactly, and does (maximum absolute IDF1 difference 0.0
against the reference deposit), which is what makes the subset cells attributable to
the subset rather than to harness drift. Within-view IDF1 rises with the cameras
available: subset means 0.669 to 0.688 at k = 2, 0.726 to 0.743 at k = 3 and 0.730 to
0.776 at k = 4, against 0.749 for the full rig — per-k means of roughly 0.68, 0.74,
0.75 and 0.75. Because the exposure shrinks with k, switch counts from different k are
compared only as rates over the camera-frames of the cameras used, never as raw sums.
The panel drawn from this measurement is not yet placed on any figure.

## Triangulation

The linear solver, which is the application's default, undistorts the observations into
ideal-pinhole coordinates and minimises the algebraic error in closed form by direct
linear transformation.

The non-linear solver minimises a geometric error in each camera's native,
still-distorted pixels while holding the cameras fixed, using a soft-L1 loss followed by
an L1 polish phase and initialised from the linear solution, with a backtracking guard
that vetoes any step which raises the objective. Because the cameras are held fixed this
is a triangulation and not a bundle adjustment, although the application's menu labels
it "Bundle Adjustment". A true joint bundle adjustment, which would free the cameras as
well as the structure, exists in the codebase and is deliberately not exposed in the
interface, because rewriting a project's calibration would invalidate every 3D point
already derived from it.

The application can optionally drop the view with the worst residual and re-solve the
point from the remaining views. Figure 4C scores the same solve before and after that
drop by its reprojection error in the kept views against their own detections, per
session — one line per session with the across-session mean — from a re-measurement
of the robust arm that records sessions, gated to reproduce the original pooled
deposit's strata means. The disagreement strata — how far the worst view sat from the
all-view solution: under 3, 3 to 10, and 10 px or more — remain in the deposit as
context rather than on the artwork, with a median 3D displacement of 7.18 mm in the
10 px-or-more stratum.

The comparison triangulator in Figures 4D and 4E is aniposelib 0.7.2, the OpenCV and
NumPy release that undistorts with cv2.undistortPoints and then solves each point with a
singular value decomposition. This is the last release before the library was rewritten
in JAX and the newest that anipose itself accepts; the build is asserted at run time and
the measurement refuses to proceed against a JAX build, because the rewrite is a
different program with different performance characteristics. The four solvers were
compared in pairs matched by algorithm class, so that the linear closed-form solve of
each library is compared with the other's and the non-linear cameras-fixed solve of each
with the other's, and each comparison is therefore between two procedures doing the same
amount of work. Enabling the library's RANSAC path costs 2,339 microseconds per keypoint,
which is 83 times the default path, and it is reported here rather than drawn because a
bar of that size would flatten every other bar in the panel. The temporal smoothing term
in the non-linear path was disabled, because the input was sampled every 60th frame and
consecutive entries are therefore more than a second apart, so the smoothing term would
penalise real motion as though it were noise; with the smoothing left enabled the
library's optimiser is worse than its own linear solve in all 50 sessions. The rule was therefore fixed
before the results were seen: the smoothing term is invalid on strided input and is
disabled. Both variants were measured and both are deposited, so the choice can be
checked.

Solve times exclude undistortion for every solver, because one library undistorts inside
the triangulation call and the other outside it, and charging only one of them would
measure where each library draws a function boundary rather than the cost of the solve;
the excluded undistortion is 0.45 microseconds per keypoint for aniposelib and 1.17 for
this work. Our solvers were timed in process under single-threaded Node 26 with
performance.now around each call, and aniposelib with time.perf_counter, taking the best
of three runs. The two libraries are written in different languages and run on different
runtimes, so this comparison is of two implementations as a user would encounter them
and not of two algorithms; the browser deployment that motivates this work forecloses a
compiled implementation, which is why the shipped solver is the one measured.

The accuracy measurement in Figure 4B is reference-free. A 3D point is solved
from a subset of the cameras, projected into a camera that was not in that subset, and
scored against that camera's own raw detection, so no reference reconstruction enters
the metric and neither solver optimises the quantity being reported. This estimator
replaced an earlier one that measured distance to the proofread reconstruction, which
cannot rank two solvers: the non-linear refinement moves the estimate in a direction
essentially uncorrelated with the direction to the reference, with a median cosine of
0.004 at two cameras, and adding a displacement orthogonal to an existing error always
increases the distance, so that measure reported that the refinement had moved whichever
way it moved. Figure 2C, by contrast, reports the 3D distance to the proofread
reference in millimetres, deliberately: there the comparison is across camera counts
within one solver rather than between solvers, so the objection above does not apply,
and the reference's own noise — its median reprojection error is 2.40 px — enters
every camera count equally. Its absolute level is therefore a comparison value rather
than absolute 3D accuracy, which its legend states.

## Reprojection recovery

Figure 6C measures how many of the detector's per-view misses the rest of the rig
could fill in by reprojection, as a function of rig size. For every keypoint-instance
— one node of one animal in one frame — g is the number of cameras whose proofread
reference carries that keypoint and m is the number of those cameras whose matched
detection carries it too. The matching is identical to the Figure 6 detection-quality
convention, a mean-keypoint-distance Hungarian assignment against the proofread
reference, run at stride 1, so "missing" in this measurement is the same notion the
detection-quality panels plot. Each session deposits its (g, m) histogram, and the
histograms are the whole measurement: every rig-size statistic is exact arithmetic on
them, with no sampling and no per-subset re-runs. A view that misses a keypoint is
recovered when at least two of the other cameras in the rig detect it, because the
keypoint can then be triangulated from those views and reprojected into the view that
missed it; one other view cannot triangulate, so recovery at a rig of two cameras is
zero by construction. For a rig of k of the six cameras, the probability that a
missing view is recoverable is an exact hypergeometric expectation over all C(6, k)
camera subsets: conditioned on the missing view being in the subset, the other k − 1
slots draw from the remaining cameras, of which m detect, and recovery requires at
least two detecting among them. Pooled over the 74 sessions, 42,184,875
keypoint-instances, 26.1 per cent of keypoints are missing per view; recovery rises
from zero at k = 2 to 45.7 per cent of misses at k = 6, leaving 14.2 per cent of
keypoints still missing at the full proofread rig.

## Behavioural analysis

A frame was counted as reared when the animal's neck height exceeded 0.75 of its own
body length, where body length is that animal's median nose-to-tail-base distance across
the session. Rearing bouts shorter than 0.25 s were discarded and gaps of 0.15 s or less
within a bout were merged.

A mutual upright display was defined as both animals being reared with their tail bases
within two body lengths of each other, held for at least 0.25 s. There are 539 such
displays in 37 of the 56 BMimica sessions.

Because a display begins only when the second animal comes up, the onset of the display
itself cannot identify which animal started it. The initiator was therefore identified
from each animal's own rearing bout containing that onset, taking whichever animal's
bout began earlier, and the lag reported in Figure 5C is the interval between the two
bout onsets.

A session's leader, in Figure 5F, is whichever of the two animals initiated more of that
session's displays. Because that statistic is the larger of the two shares it cannot
fall below 0.5, so it was read against a simulated null rather than against a line at
0.5: for each session size, the 95th percentile of the larger share under a binomial
distribution with probability one half was estimated from 20,000 draws. The figure
reported in the text is pooled over displays rather than averaged over sessions, and the
per-session statistics are restricted to sessions containing at least five displays.

Because the 37 sessions are repeated recordings of a smaller number of pairs, the same
analysis was repeated with the PAIR as the unit of replication. Aggregating every
session of a pair into one observation gives 14 pairs with at least five displays,
covering 536 displays. The leading member of the pair starts a median 0.81 of that
pair's displays (interquartile range 0.74 to 0.91, range 0.60 to 1.00), and the same
member leads in all 14 of 14 pairs (sign test P = 1.2 x 10 to the minus 4; Wilcoxon
signed-rank on the pair shares against 0.5, P = 9.7 x 10 to the minus 4). Eight of the
14 pairs are individually above chance by a two-sided binomial test. Pooled over those
pairs the leader starts 429 of 536 displays, 80.0 per cent, which is the same figure the
session-level pooling gives. The result is therefore not an artefact of treating
repeated recordings of one pair as independent.

Three controls were run on the initiator asymmetry. It is not explained by the rearing
base rate, since a session's initiation share is uncorrelated with that animal's share
of rearing time (Pearson r = -0.012, P = 0.96; Spearman rho = 0.044, P = 0.84; n = 24
sessions with at least five displays). It is not an artefact of the per-animal height
threshold, since re-running the whole detection with a single threshold shared by both
animals returns the same leader in 22 of 24 sessions and an absolute 60 mm threshold
returns the same leader in all 24. It is not body size: in the eight sessions where the
initiating animal is the longer of the pair it still starts 81 of 103 displays, 79 per
cent (binomial against 0.5, P = 4.1 x 10 to the minus 9).

The coupling in Figure 5G was computed by taking every rearing onset by one animal and
reading out the probability that the other animal was rearing at each lag within five
seconds either side, divided by that other animal's own base rate. Onsets were split by
the tail-base separation at the moment of onset, into those within two body lengths and
those beyond. The null distribution was generated by circularly shifting the other
animal's rearing time series, 24 shifts per ordered pair, which preserves that animal's
rearing rate, its bout durations and its autocorrelation while destroying only the
temporal alignment between the two animals; a reshuffle would additionally have
destroyed the autocorrelation and would have made almost any structure appear
significant. A session contributed a curve to a condition only if it supplied at least
20 onsets in that condition. The same measurement on the two-animal sessions of SLAP-2M
gives 1.08 within two body lengths and 0.97 beyond, but that arena is 3.2 body lengths
across against BMimica's 6.9, so the two conditions barely differ there and the claim is
made for BMimica alone.

## Tracking metrics

IDF1, identity switches and fragmentations were computed with the motmetrics library on
the shared detection pool. Within-view IDF1 was computed separately for each camera and
averaged. Cross-view IDF1 pools all cameras into a single accumulator with one global
identity per animal. For a tracker that has no cross-view identity of its own, that
pooling is CAMERA-SCOPED: its hypothesis ids are keyed by camera, so the same track
number appearing in two cameras is two identities, and global ids are used only for
methods that actually assert cross-view identity. The scoped convention is the
conservative one — unscoped pooling can only add cross-view matches, and with two
enforced tracks per camera it would credit the capped SLEAP baseline of Figure 7A with
a cross-view IDF1 of 0.600 through nothing but shared slot numbering. Under scoped
pooling a method that labels each camera independently can be matched to the truth in
at most one camera, which puts such a method near 1/C; that level is a property of the
pooling convention rather than a strict bound, and chance is set by the number of
animals rather than the number of cameras. A fragmentation was counted each time a
tracked ground-truth track became untracked and was later picked up again, which is a
different event from an identity switch, in which the track continues but is assigned
to the wrong animal. Error terms are reported as percentages of camera-frames. False
negatives were measured but are not plotted, since they account for 98.8 to 99.3 per
cent of every method's error budget and would draw three indistinguishable bars.

ID accuracy (IDA) is idtp divided by the number of matches: of the detections matched
to a ground-truth animal, the fraction carrying the correct identity. It excludes both
detector misses, which sit in IDR's denominator, and false-positive detections, which
sit in IDP's, so it isolates the association from the detector on both sides, and
IDA >= IDP always. For the fresh-anchor configuration on the 50 BMimica sessions,
pooled IDA is 92.46 per cent (72,794,704 of 78,734,134 matches), the session median is
100 per cent and the worst session 56.6 per cent; false-positive detections are 0.104
per cent of matches (81,754). The shipped tracker on the same corpus pools to 80.56
per cent (63,422,131 of 78,728,126 matches), with a session median of 84.0 per cent
and a worst session of 53.3 per cent.

## Baseline configuration

The per-camera baselines in Figure 7A are re-run at the most favourable configuration
we could give them, because the shipped comparison charged them for constraints
LUC3D's arm does not face: LUC3D holds two global identities by construction, while
SLEAP ran with an unbounded track pool and ByteTrack with a 2-second retirement
horizon on 20-minute sessions.

SLEAP was re-run with the track count capped at the true animal count. The original
retrack ran sleap-nn 0.3.0 with no cap — its --max_tracks option is honoured only
under candidates_method 'local_queues', and the default 'fixed_window' silently
ignores it — yielding a median of 47 tracks per camera-session. The re-run adds
exactly two flags, --max_tracks 2 --candidates_method local_queues, and changes
nothing else, so the only difference between the runs is the cap; the cap was
verified after the fact, with all 250 camera-sessions holding at most 2 tracks. The
output is scored from the tracked .slp files directly, every track.

ByteTrack was re-run with track retirement disabled — lost_track_buffer set to the
session length, against the shipped 60 frames (2 s), which retires a track on any
longer occlusion — and its output was then reduced to two identities by a greedy,
tracklet-whole stitch that uses no ground truth: each ByteTrack id is bound at birth
to one of two slots, the slot whose last-seen box is nearest the tracklet's first box
(intersection-over-union first, centroid distance as the tie-break), among slots not
held by an id alive in the same frame, and keeps that slot for life, so ByteTrack's
own association is untouched. The never-retire knob alone reaches within-view IDF1
0.272; with the stitch, 0.676. Two gates anchor the re-runs to the shipped
measurement: re-scoring the shipped ByteTrack arm through the re-run's scorer
reproduces the reference evaluation to a maximum absolute difference of 0.0 on all 50
sessions, and re-running one camera-session at the shipped parameters under the
pinned library version reproduces the stored output cell for cell.

3D-MuPPET could not be made fair the same way, and its Figure 7A number is reported
as the coverage artefact it is. Its detector was replaced by the shared pool and its
dmin retuned from 200 to 100 mm for mouse scale, so what runs is the published
method's tracking logic on our detections; but that logic builds its camera-to-global
identity map once, at the initialisation frame, while its SORT tracker retires tracks
after 10 frames, so once a tracklet dies that camera goes permanently silent.
Assignments cover a median 1.31 per cent of a session (range 0.17 to 7.22 per cent),
a contiguous prefix from frame 0 in all 50 sessions, and every unlabelled frame
scores as a miss; on the frames it does label it scores within-view IDF1 0.21 to 0.67
(4 sessions, first 20,000 frames) with coherent identities where present.

## Statistics

The session is the unit of analysis throughout unless stated otherwise. For BMimica this
is a conservative-sounding choice that is not automatically conservative, because the 56
sessions are repeated recordings of 9 mice in 18 pairings; where a session-level test
carries a claim, the same test with the pair as the unit is reported beside it (Figure
5F). For SLAP-2M the individual animals are not identified in the metadata, so no
finer unit is available. Medians and
interquartile ranges are used for the error distributions, which are right-skewed, and a
band labelled as running from the 25th to the 75th percentile is an across-session
spread of per-session medians rather than a confidence interval. Bootstrap confidence
intervals at 95 per cent over sessions are used for the paired comparisons in Figures
7A, 7C and 7F. Sign tests are used for paired per-session comparisons of direction in
Figure 7C. A Wilcoxon signed-rank test is used for the paired session-level comparison
against a fixed value in Figure 5F. Binomial nulls were simulated rather than
approximated wherever the statistic is a larger-of-two share, using 20,000 draws per
session size. Circular-shift nulls were used for the temporal coupling in Figure 5G. No
correction for multiple comparisons is applied across figures, and where a family of
per-session tests is reported both the uncorrected and the Holm-corrected counts are
given.

## The application

LUC3D is a multi-view pose annotation and 3D proofreading interface that runs entirely
in a web browser. It is served as static files with no installation and no build step,
either from the hosted deployment or from any local static file server, and it keeps no
state on a server, so a project is simply a set of local files that the user opens and
saves.

It loads multi-camera video with frame-accurate WebCodecs decoding and scrubbing
synchronised across every view, camera calibration in TOML or JSON, and SLEAP
predictions, which are read lazily so that a prediction file larger than available
memory can still be opened. Several recording sessions can be held open at once, each in
its own dockable pane. A project can also be opened with no video at all, as a skeleton
together with imported 3D points, in which case the whole duration of the reconstruction
remains navigable.

Skeleton instances and their keypoints are created and edited directly on the video
frames, and the node and edge definitions themselves can be edited inline. The
reprojection-aided labelling protocol quantified in Figure 2 is available in the
interface: the user labels two views, the 3D point is solved from those two alone, and
the reprojection appears in every remaining view to be accepted or nudged.

A cross-view tracker groups the detections that belong to the same individual across
views and assigns one identity per animal per frame, which is the capability measured in
Figures 3 and 7. Its behaviour is exposed through a guided dialogue that offers per-node
weights, per-view inclusion and the cost thresholds described above, so that the
association can be tuned to a particular rig rather than accepted as a fixed policy.
Tracks and identities are held per session and propagate to one another, so that a
correction to either is reflected in the other.

Triangulation is offered as the linear solve and as the non-linear refinement described
above, with optional rejection of an outlying view. The reconstruction is drawn in an
interactive Three.js viewport that also renders the calibrated camera frustums, can be
placed at any camera's own pose and field of view so that it can be compared directly
against that camera's video, and can be exported as an MP4 video.

Reprojection error is surfaced for each keypoint and each view as an overlay on the
frame the user is working on, which is the signal a proofreader works from; detections
are drawn as solid marks and reprojections from the 3D as dotted ones. A timeline widget
in the style of SLEAP carries frames, tracks and labelled regions for navigation, and
the keyboard shortcuts are listed and can be rebound in the settings dialogue.

Projects are written as SLEAP .slp files, including the columnar session data introduced
in version 2.8 of that format, which carries the calibration, the cross-view identities
and the 3D points, so that a project round-trips through SLEAP and through this
application without loss. Labels can also be exported as JSON, 3D points as HDF5, and
the 3D viewport as MP4.

## Software

The application is written as vanilla ES modules with no build step. It reads and writes
version 2.8 of the SLP format through a vendored copy of sleap-io.js and HDF5 through a
vendored copy of h5wasm, and renders in three dimensions with Three.js. A recent
Chromium-based browser is recommended, because frame-accurate decoding uses WebCodecs.
The benchmark drivers run the unmodified application modules under Node 26, so the
association and triangulation measured here are the shipped code paths rather than a
reimplementation of them. Analysis and figures were produced in Python 3.12 with NumPy,
pandas, h5py, SciPy and Matplotlib. Tracking metrics come from motmetrics and the
comparison triangulator from aniposelib 0.7.2.

## Figure generation

Each figure is assembled from per-panel PDF files. A measurement pass writes a JSON
deposit, a panel script reads that deposit, writes the plot-ready table as CSV and
renders one PDF at an exact size on a 180 mm column grid, and an assembler places the
panels, draws the letters and titles and refuses to build a row wider than the page.
Panels are never trimmed to their ink, so that two panels of the same class are
identical in size and their axes align across a row. A linter reads the emitted PDF
files and reports any text that overlaps other text, sits on a data mark, falls outside
the page or is set below five points. Text on the artwork is limited to axis labels,
series names and the numbers a panel is about; all other prose is in the legends.
