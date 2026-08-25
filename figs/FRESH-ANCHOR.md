# Anchor staleness in cross-view identity tracking

*Methods and Results, prepared in Nature Neuroscience format. The parameter
sweep referenced throughout is Supplementary Fig. 8
(`figs/figures/fig8/fig8.png`), panel d.*

## Methods

### Cross-view tracker

Cross-view identity assignment followed the tracking-by-3D-consensus framework
of Chen et al. (2020), as implemented in the sleap-3d reference and ported to
LUCID (`pose/cross-view-tracker.js`). Each animal identity is represented by a
persistent target comprising, for every camera, the most recent detection
matched to that identity, together with a three-dimensional anchor obtained by
direct linear transform (DLT) triangulation over those retained per-camera
detections. Views are processed sequentially within each frame. For every view,
an affinity matrix between targets and that view's detections is constructed
and solved as a one-to-one assignment with the Hungarian algorithm; the
assignment is joint over all targets and detections, so no target selects its
match independently of the others. The affinity of a target–detection pair is
the sum of two terms, both evaluated against the target's anchor: a
two-dimensional term comparing the anchor's reprojection into the view with the
detection, attenuated by exp(−λΔt), where Δt is the interval between the
detection and the mean age of the target's retained detections (time penalty
λ = 0.1); and a three-dimensional term comparing the anchor with the rays
back-projected through the detection's keypoints, rewarded within a distance
threshold and penalized beyond it. Following the reference implementation, the
three-dimensional term carries no temporal attenuation (its decay is fixed at
exp(0) = 1). Matched detections replace the corresponding camera's retained
detection and the anchor is re-triangulated; detections matched to no target
accumulate per view, and when two views hold unmatched detections they are
assigned to one another by Hungarian matching on epipolar error, each matched
pair initializing a new target. Baseline hyperparameters were the benchmark
configuration of the reference (2D correspondence weight 1.0, 3D correspondence
weight 6.0, velocity threshold 10, distance threshold 50).

### Provenance of the staleness defect

Chen et al. (2020) retain the last observed point per camera (their Eq. 6) and
attenuate each retained point's contribution to the incremental triangulation
exponentially with its age, w_i = e^(−λ_t(t−t_i))/‖c_i^T‖₂ (their Eq. 11). In
the sleap-3d reference these weights are computed
(`incremental_3d_reconstruction`) but are not applied: the triangulation routine
(`triangulate_dlt_vectorized`) accepts and ignores them, so retained detections
of any age enter the anchor at full weight. The LUCID port reproduces this
effective behavior. We additionally note that the reference computes the weight
with inverted sign (time differences are non-positive, so e^(−λ_t Δt) ≥ 1 and
older points would receive larger weights were the routine completed as
written), and that the omission is nearly inconsequential in the regime of Chen
et al., where retained points span 0–300 ms; in freely behaving animals,
occlusions leave retained detections stale by thousands of frames.

### Measurement of anchor age

The age of every retained detection entering a re-triangulation was logged over
eight Mouse-Dyad-10M sessions (`figs/fig8_diag_anchor_age.py`). Per-session mean
ages were 3.0–49.8 frames; maxima were 844–8,652 frames (approximately 5 min of
recording), confirming that anchors routinely fused evidence from positions the
animal had long vacated.

### Anchor-eviction tracker (fresh anchor)

Three coordinated modifications were evaluated. (1) Staleness eviction: at the
start of every frame, each target deletes retained detections older than N
frames (N ∈ {1, 10, 20, 30}), so the anchor can be triangulated only from
cameras that observed the animal within the last N frames. A target left with
fewer than two retained detections keeps its last valid anchor but ceases to be
re-triangulated; its two-dimensional affinity decays toward zero with Δt while
its three-dimensional affinity remains confined to the distance-threshold
neighbourhood of the frozen anchor. Animals lost outright re-enter through the
epipolar initialization path rather than through a bid from an obsolete
position. Eviction is the step-function limit of the exponential attenuation of
Chen et al.'s Eq. 11. (2) Synchronous scoring (denoted M1): every target's
anchor is snapshotted at frame start, all views are scored against the
snapshot, and targets are re-triangulated once at frame end, so that a wrong
assignment in one view cannot contaminate the evidence against which subsequent
views of the same frame are scored, and results no longer depend on camera
order. (3) The distance threshold of the three-dimensional term was reduced
from 50 to 25, tightening the acceptance region around any residual frozen
anchor. The assignment algorithm itself was unmodified; all effects arise from
the evidence entering the affinity computation. Experiments were run in a
benchmark harness that overlays the experimental tracker
(`figs/fig8-bench/xv_experimental.js`) on the production module via a module
loader hook, leaving the shipped implementation untouched.

### Benchmark, metrics and statistics

Configurations were evaluated on all 50 Mouse-Dyad-10M sessions with proofread
3D ground truth (two mice, five synchronized cameras, 150 frames s⁻¹,
approximately 180,000 frames per session), using identical per-camera
detections across all arms. Before any comparison, the harness was validated by
reproducing the shipped tracker's independently deposited 50-session result
exactly (cross-view IDF1 0.74925…, 2,071 switches; bit-identical). Identity
quality was scored as cross-view IDF1 against the proofread ground truth and as
within-view identity switches, reported both as counts and as a percentage of
camera-frames. Paired configuration comparisons used the two-sided Wilcoxon
signed-rank test over the 50 sessions. As specificity controls, the staleness
axis was also traversed in the opposite direction: exponentially smoothing the
anchor (making it staler; smoothing constant 0.1) and freezing the anchor on
frames where the assignment margin fell below a threshold (margins 100 and
400). Deposits: `figs/out/fig8_methods_50.json`; sweep panels in Supplementary
Fig. 8.

## Results

### Stale evidence in the anchor is the dominant identity-switch mechanism

The reference tracker retains, per camera, the last detection matched to each
identity and re-triangulates its 3D anchor from all retained detections with no
age limit. Measured over eight sessions, detections entering this fusion
averaged 3.0–49.8 frames old per session, with maxima of 844–8,652 frames.
Because the three-dimensional affinity term carries no temporal attenuation, an
identity that lost its animal minutes earlier continues to bid for detections
at full strength from its last known position; when the other animal passes
through that position, the joint assignment concedes it, and in the absence of
any appearance cue the swap is permanent — identity errors of this kind,
rather than detection or grouping errors, account for the large majority of the
tracker's IDF1 deficit.

### Evicting stale evidence removes most switches

Deleting each target's retained detections older than N frames before matching,
combined with synchronous per-frame scoring and a tightened 3D distance
threshold (Methods), reduced within-view identity switches from 2,071 (0.00460%
of camera-frames) to 413 (0.00092%) at N = 20, an 80% reduction, and raised
mean cross-view IDF1 from 0.7493 to 0.8613 over the 50 sessions (Supplementary
Fig. 8d). At N = 10 the corresponding values were 511 switches (0.00114%) and
IDF1 0.8498, with the median session rising from 0.7604 to 0.9127; 32 of 50
sessions improved and 6 worsened (two-sided paired Wilcoxon, P = 1.7 × 10⁻⁶).
The eviction configuration exceeded the best pure-threshold re-tuning of the
unmodified tracker by a median of +0.078 IDF1 (P = 2.7 × 10⁻⁵). Synchronous
scoring alone contributed approximately +0.027 IDF1 and −28 switches; its
principal effect was to make eviction effective by preventing one view's error
from contaminating the evidence scored by the remaining views of the same
frame.

### The effect is specific to anchor freshness and monotone

Traversing the staleness axis in the opposite direction was monotonically
harmful across four orders of magnitude: exponentially smoothing the anchor
(smoothing constant 0.1) increased switches to approximately 2,800, and
freezing the anchor on low-margin frames produced approximately 1,700 switches
at margin 100 and 27,042 at margin 400. Alternative levers evaluated on the
same harness — re-weighting the association cost terms, cross-view consistency
terms, constant-velocity motion models, and skeletal re-identification — were
substantially weaker on this corpus. Among eviction windows, differences were
small and unstable: N = 1 versus N = 10 reversed order between an 8-session
pilot and the 50-session benchmark (0.8393 versus 0.8498; P = 0.8), indicating
that the material step is from no eviction to any eviction, not the choice of
window (Supplementary Fig. 8d, parameter sets 2–5). We adopt N = 10 rather than
the switch-count minimum N = 20 on harm profile: 6 rather than 9 sessions
worsened, with worst per-session change −0.138 rather than −0.215.

### Relation to prior work

The mechanism corrects an implementation omission rather than introducing a new
principle. Chen et al. (2020) attenuate retained per-view evidence
exponentially with age in their incremental triangulation (their Eq. 11); the
reference implementation computes but does not apply these weights, and the
omission is benign at their time scales (retained points 0–300 ms old) while
dominant at behavioral time scales, where occlusions stale the evidence by
minutes. Hard eviction restores, and by its monotone dose–response strengthens,
the original design. The related convention in monocular multi-object tracking
is track termination after a maximum unmatched age (SORT, Bewley et al., 2016;
DeepSORT, Wojke et al., 2017); eviction differs in that it ages the per-view
evidence within a persistent identity rather than terminating the identity
itself.

## References

- Chen, L., Ai, H., Chen, R., Zhuang, Z. & Liu, S. Cross-view tracking for
  multi-human 3D pose estimation at over 100 FPS. In *Proc. IEEE/CVF Conf.
  Computer Vision and Pattern Recognition* (CVPR) (2020). arXiv:2003.03972.
- Bewley, A., Ge, Z., Ott, L., Ramos, F. & Upcroft, B. Simple online and
  realtime tracking. In *Proc. IEEE Int. Conf. Image Processing* (ICIP) (2016).
  arXiv:1602.00763.
- Wojke, N., Bewley, A. & Paulus, D. Simple online and realtime tracking with a
  deep association metric. In *Proc. IEEE Int. Conf. Image Processing* (ICIP)
  (2017). arXiv:1703.07402.
