# Figure captions

Manuscript captions for Figs 1–7. **This is where the prose lives.** A review measured
**1,604 words of running text printed on the artwork** across the seven figures — the
single biggest reason the drafts read as unprofessional. Nature panels carry a 0–4 word
noun title, axis labels, and nothing else; findings go in the caption's bolded lead
sentence, methods go in Methods, and self-criticism goes in a Supplementary Note.

Convention below: **bold lead** states the finding; the rest gives n, corpus and the one
caveat a reader needs. Anything longer belongs in Methods.

---

## Figure 1 — System overview

**Fig. 1 | LUC3D performs multi-camera 3D annotation and proofreading in a browser
with no installation, and gives each animal one identity in every view.**
**a**, Pipeline, six stages from videos plus calibration to export. The three teal
chevrons and the bracket beneath them mark the stages contributed here: cross-view
re-identification, triangulation and 3D proofreading. The 2D detector is not ours —
per-view pose comes from SLEAP or any other predictor and LUC3D consumes `.slp`.
**b**, One frame
(frame 150) of an 8-camera, 3-mouse recording, 15-node skeleton. Left, the
per-camera SLEAP tracks the app is given; right, the same two views after
cross-view re-identification. Two of the eight views are shown: cam 0 mid, the
view reconstructed in **c**, and cam 7 sideR, one of the two views in which
per-camera tracking returned a fourth detection for three animals. Labels are the
track name (left, abbreviated on the artwork — `t89` is `track_89`) and the identity
(right, the app's `id_0`–`id_2` printed 1–3). Every detection carries its own label,
and the labels *are* the correspondence: no ellipse, ring or connector is drawn
between the two pairs. The animal labelled `track_89` in cam 0 and `track_83` in
cam 7 is one animal and becomes identity **1** in both, which is the collapse the
panel is about. Track colours are the app's arbitrary per-camera
track colours and carry no meaning across views — that is what the panel is about;
identity colours are shared by every view. Across all eight views the frame holds
**26 detections, i.e. 26 per-camera track labels**, which resolve to **3
identities, each present in all 8 views**. **24 of the 26** detections are
assigned. The other two (`Camera3_sideC/track_226`, 14 of 15 nodes visible;
`Camera7_sideR/track_95`, 9 of 15) are duplicate detections of an animal already
matched in that view: assignment is one-to-one per view, so a duplicate is left
unassigned and marked **?**, the app's own badge for a detection linked to no
identity. Illustration; quantified in Figs 3 and 7. **c**, The same frame
triangulated. Left, cam 0 mid's video with the identity overlays; middle, LUC3D's
3D viewport placed at that camera's own pose and field of view (its "Show Camera
View"), rendered at the camera's aspect ratio and cropped to the identical
normalised region, so the two can be compared directly; right, the rig, all eight
calibrated cameras plus the three reconstructed animals in their identity colours.
The rig tile carries geometry only — the app's camera name labels are switched off,
because they are screen-space bitmaps at a fixed pixel size and pile up at the
magnification this tile needs. Two *pairs* of cameras project within ~12 px of each
other in the 799 × 450 render (`Camera0_mid`/`Camera4_topR`, 11.6 px;
`Camera2_topC`/`Camera7_sideR`, 13.3 px; `fig1.json threeD.rigFraming.camScreen`), so
fewer than eight frustums are separable by eye at this viewing angle; every camera's
projected position is deposited for a composer that wants to typeset the names.
All 3 animals were reconstructed, with all 45 of 45 3D
keypoints (15 nodes × 3 animals) filled. **d**, Capability comparison; every
non-LUC3D cell was checked against that tool's published documentation on
2026-08-04 (see qualifications below).

**Panel d qualifications.** *SLEAP*: multi-camera 3D exists outside the GUI, in
sleap-io's `RecordingSession`/`FrameGroup`/`InstanceGroup` (the SLP 2.8
`/session_data` format LUC3D itself writes) with triangulation via sleap-anipose;
annotation-time cross-view association is the exhaustive hypothesis test of Maree
et al. (2024); proofreading is in 2D, as there is no 3D viewport. *Label3D* and
*JARVIS* both provide reprojection-aided multi-camera annotation, and neither
documents simultaneous multi-animal labelling; JARVIS surfaces a reprojection
error bar rather than a 3D viewport. *DeepLabCut*'s 3D module triangulates one
animal from camera pairs; its multi-animal support is 2D. *Anipose* is a
single-animal, CLI-driven pipeline. *Lightning Pose* is the other browser-based tool
in the table (`litpose run_app` serves a browser GUI); its documented multi-view
support is multi-view consistency and triangulation *losses* at training time, not a
calibrated pipeline emitting 3D coordinates and no calibration format is documented,
so its cell reads "multi-view losses" rather than a tick, and multi-animal is not a
documented feature. *DANNCE/SDANNCE* infer 3D directly from image volumes, so
per-view identity association does not arise — the dash in "Cross-view ID" means "not
applicable", not "worse"; the row is titled "DANNCE / SDANNCE" and the multi-animal
tick is SDANNCE, which ships in the same repository. **The `–` in SLEAP's Cross-view
ID cell is not a contradiction of Fig 3.** Fig 3 compares against the exhaustive
method of Maree et al. (2024), whose title ends "…in SLEAP", but that is a method
paper, not a capability a SLEAP GUI user can turn on; a capability table must not
credit shipped software with an unshipped method. The citation belongs to Fig 3, and
Fig 3 gives it.

**Methods notes.** Every panel is the real app driven over real data (an 8-camera
window trimmed from `20260605_133431-HardFight`, 60 fps, 300 frames), and every
number above is read back from that run (`figs/out/fig1.json`) and re-checked
against the per-view detection lists at figure build time. Per-view brightness is
a display gain (1.9×) applied identically to every tile, to the video only, never
to the overlay. Identity colours are an Okabe-Ito palette with the green lifted to
`#00b478` for contrast against dark infrared video; the app's shipped default
(`#00ff00`, `#ff00ff`, `#00ffff`) is not colourblind-safe for the first three
identities. Over the whole 300-frame window, Track All produced 3 identities and
Triangulate All reconstructed 900 of 900 instance groups.

---

## Things the caption deliberately does NOT claim

* **No overhead/side camera counts.** The earlier draft printed "5 overhead + 3
  side cameras" on the rig tile, derived by substring-matching `top`/`mid` versus
  `side` in the camera *names*. That rule is wrong: computing camera centres
  (`−RᵀT`) and optical axes (`Rᵀ[0,0,1]`) from the session calibration gives four
  cameras with axes 58–89° from horizontal and four at −6° to 21°, i.e. **4 + 4**.
  `Camera2_topC` is named "top" but looks 21° below horizontal, and `Camera0_mid`
  — the view shown in **b** and **c** — looks almost straight down. Rather than
  print a classification the figure cannot derive from `figs/out/` (the calibration
  lives in the gitignored `figs/session/`), the artwork says only "rig" and the
  caption says "eight calibrated cameras". If a reviewer asks for the split, quote
  the 4 + 4 from the calibration, not the names.
* **22.** `distinctTrackNames` = 22 is the 26 per-camera track labels collapsed by
  name. Three names are reused by more than one camera (`track_89` in cams 0 and
  5, `track_93` in cams 5, 6 and 7, `track_127` in cams 1 and 4). Two of those
  three coincidences happen to land on the same animal; `track_127` does not — it
  is identity 2 in cam 1 and identity 1 in cam 4. Either way the numbering carries
  no cross-view meaning, and quoting 22 would understate the association problem
  by exactly the collisions that make it worse. Use **26**.
* **"a different track label in every view."** True for the two views shown and
  false as a general statement about this frame, for the reason above. The caption
  names the two per-view labels of one specific animal (`track_89` in cam 0,
  `track_83` in cam 7) instead.
* **Pixel-exact 2D/3D agreement.** The 3D viewport is set to cam 0 mid's real
  extrinsics and to the vertical field of view implied by its intrinsics
  (2·atan(h/2f_y) = 63.7°) at the camera's aspect ratio, so the effective focal
  length matches and the same normalised crop frames both tiles. But the viewport
  renders an ideal pinhole camera while the video frame carries the lens distortion
  (k₁ = −0.36 on this camera), so agreement is close, not pixel-exact, and degrades
  toward the frame edge. "Directly comparable" is the strongest safe wording.
* **Eight-view grids.** The 4 × 2 before/after grid the earlier draft showed is
  ~45 mm of page for no additional claim; it belongs in Extended Data. The
  statement it supported — that all three identities are present in all eight views
  — is asserted in the caption *and* verified at build time: `fig1.py` refuses to
  print "in all 8 views" if any view is missing an identity.

---

## Figure 2 — Reprojection-aided labelling

**Labelling two anchor views and accepting the reprojection in the rest cuts manual
keypoint placements 2.3-fold on this five-camera rig — 75 placements per animal per
frame to 32 — because only 5.4% of reprojections fall outside a 10 px tolerance and
need touching at all.**
(a) The protocol in the app, in four steps: two anchor views labelled (cam 1 topB,
cam 6 sideL); the 3D solved from those two alone (the other six views set to weight 0
in the app's Camera Views panel, so they cannot contribute); the resulting reprojection
drawn into every remaining view (cam 0 mid and cam 2 topC shown, neither labelled); and
one view magnified beside that frame's measured per-view error split. **This protocol is
not novel and the figure does not claim it is**: JARVIS's AnnotationTool already
projects manual annotations from a subset of cameras onto the remaining ones and
surfaces a reprojection error bar, and Label3D is the direct predecessor for
reprojection-aided multi-camera 3D labelling. Both are in the Fig 1d table and both are
cited here. What is new is the browser implementation and the quantification in b–d.
(b) Manual keypoint placements per animal per frame against rig size C, for two accept
tolerances (τ = 10 px solid, τ = 5 px dashed) against traditional labelling. τ is the
tolerance at which a labeller accepts a reprojection untouched and p the measured
fraction that miss it. **Only one rig size was measured, and the panel says so rather
than shading a region.** All 50 BMimica sessions are five-camera rigs, so p is a single
number measured at C = 5 from a two-anchor solve with three held-out views — the one
filled marker on the whole panel. Every other point on both curves, at C < 5 exactly as much
as at C > 5, is the model `aided = 2N + (C−2)·N·p` against `traditional = C·N` with
N = 15. The 2.3× is annotated at that one measured C and nowhere else.
(c) Where the reprojection lands in views that were not labelled, scored against the
held-out view's own detection (solid) and against the fully-informed reference 3D
(dashed); the rule marks τ = 10 px.
(d) Median 3D error of a two-anchor solve against the angle that anchor pair subtends
at the animal, one marker per camera pair; the dashed curve is the depth-uncertainty
law k/sin θ with k = 1.52 mm and the band is ±25%, and the dotted rule is the
all-five-view comparison floor (1.2 mm).
n = 50 BMimica sessions, 1,277,424 keypoints, 5 cameras, 2 mice, 15 nodes; every
session enters every panel.

## Second finding, for panel d

**Which two views are chosen matters more than that only two were chosen: on this rig
the widest available pair gives 2.7 mm of median 3D error and the narrowest 12.6 mm, a
4.7-fold difference that costs nothing at annotation time.** The ordering is not
marginal — the widest pair (cameras 0 + 1, 31.5°) is the most accurate pair in 50 of 50
sessions and the narrowest (cameras 1 + 2, 13.5°) the least accurate in 50 of 50.
Baseline angle is the **dominant, not the sole** factor: fitting err = k/sin θ (k =
1.52 mm, estimated robustly as the median of err·sin θ) puts 8 of the 10 pairs within
±25%, and the two exceptions both pair camera 2 — the most distant camera, 1.32 m from
the animals against 0.98–1.07 m for the other four — with its two angular neighbours,
where a narrow angle and a coarse mm-per-pixel compound. This concerns only which two
views you *label*; the final reconstruction should still use every available view
(1.22 mm).

## Methods

* Frames uniformly strided (stride 200; 45,053 of 9,004,392 frames). Identity matched
  per view against the reference reprojection.
* τ = 20 px is the app's own `reprojSigma` default (`ui/settings.js`) and is the accept
  threshold panel c quotes against; **panel b draws τ = 10 px and τ = 5 px only**, so
  the headline ratio is the τ = 10 px one. Placement model `traditional = C·N`,
  `aided = 2N + (C−2)·N·p`, with N = 15 the per-animal skeleton.
* Measured p: 40.1% at τ = 5 px, **5.4%** at τ = 10 px, 0.32% at τ = 20 px. At the
  measured rig size C = 5 that is 75 → 32.4 placements (**2.3×**, the value annotated on
  panel b) at τ = 10 px, 75 → 30.1 (2.49×) at τ = 20 px and 75 → 48.0 (1.56×) at
  τ = 5 px. The τ = 20 px row is deposited but appears on **no artwork** — do not quote
  its 2.49× as the figure's headline. The C = 8 value at τ = 10 px, **3.44×**
  (120 → 34.9), is an **extrapolation of the model past the one measured rig size**, not
  a measurement; the panel marks this by carrying exactly one filled marker in total,
  not by shading a region.
* Panel c: 38,322,720 held-out view measurements (every camera pair × every
  held-out view × every keypoint × 50 sessions). Median 4.32 px against the view's own
  detection (p90 8.49, p99 14.91; **59.9%** ≤ 5 px, **94.6%** ≤ the marked
  τ = 10 px, and 99.68% ≤ 20 px) and 2.67 px against the reference 3D. Between-session spread
  is small: per-session medians 2.79–4.91 px, and 98.99–99.88% within 20 px in every
  session.
* Panel d: 12,774,240 two-anchor solves (10 pairs × 50 sessions). Both
  coordinates of each marker are medians across all 50 sessions — the baseline angle
  moves a little between sessions because its vertex is that session's own mean
  proofread 3D point. Camera centres come from the calibration extrinsics as
  C = −Rᵀt; the vertex is the mean proofread 3D point, i.e. the real animals.
* **What "3D error" means here, since it is neither of the two things a reader will
  assume.** It is *not* a reprojection error (it is millimetres, not pixels), and it is
  *not* our k-view solve against our own 5-view solve — if it were, the k = 5 point would
  be identically zero by construction. It is the 3D Euclidean distance between (i) the
  candidate, a DLT triangulation from k chosen views, and (ii) the **corpus's proofread
  3D**, which comes from a different pipeline and is mapped into our calibration frame by
  a RANSAC similarity fit (scale, rotation, translation), then converted to millimetres
  through the recovered metric scale. Median 3D error by number of anchor views labelled:
  2 → 4.75 mm, 3 → 2.91, 4 → 1.92, 5 → 1.22.
* **Why a coordinate-frame fit is needed at all, and why the 1.22 mm floor is NOT an
  artefact of it.** The proofread 3D ships as `*_points3d_translated_rotated_metric.h5`:
  it was deliberately translated, rotated and converted to **metres**, while the
  calibration frame is in millimetres (the recovered scale is ~995 or ~1013 depending on
  which of the corpus's two calibrations a session uses). A RANSAC similarity fit undoes
  that post-processing, and it fits well — 97–98% inliers in every session.
  **Its median residual (1.20 mm) and the k = 5 error (1.22 mm) are the same measurement
  on different frame subsets** — both are "our all-camera DLT of the per-camera 2D against
  their proofread 3D", one fit on a ~4,000-frame sample and one evaluated on the strided
  analysis frames. Their 1.4% agreement is therefore near-tautological and must not be
  read as "alignment error dominates".
* **What 1.22 mm actually is, and what it bounds.** It is the genuine median disagreement
  between our five-view reconstruction and the corpus's proofread 3D, absorbing three
  things at once: the 2D detector's error, whatever human correction the proofread pass
  applied in 3D, and any residual frame mismatch. It is a floor on what *this comparison*
  can resolve, so the absolute values cannot be read as absolute 3D accuracy — the
  reference has its own error (median reprojection 2.41 px, higher than either candidate
  solver's, which is the same reason Fig 4 makes no 3D comparison between solvers). The
  *spacing* between the four values is what the panel supports: two anchors cost ~3.5 mm
  relative to five. "Five views are accurate to 1.2 mm" is not supported.
* Panel a is one frame of an 8-camera HardFight recording; panels b, c and d are the
  5-camera BMimica corpus, which is the only one with a proofread 3D reconstruction to
  measure against. The figure's footer states this.

## Supplementary Note

* **The reference is not absolute ground truth.** Panel d scores a two-view solve
  against the **five-view** reconstruction *from the same cameras and the same
  calibration*, so those millimetres are agreement with the fully-informed solve, not
  absolute 3D accuracy. The reference 3D is itself a multi-view solve whose own
  reprojection error on these detections is **2.41 px (median;** `fig4.json`
  `reference_reproj_px.p50` over all 50 sessions, mean 2.73 — quote the median and say so), higher than
  either candidate solver's, which is why distance to it cannot rank solvers (Fig 4).
* **The "all 5 views" floor is close to, but not identical with, the alignment
  residual.** Median 1.22 mm against a median RANSAC–Procrustes residual of 1.20 mm,
  1.4% apart, and **47 of 50 sessions agree within 5%**; three do not (5.2%, 24.5% and
  27.8%, relative to that session's alignment residual). The earlier claim of "within
  2–5% in every session" was false.
* **Bone-length coefficient of variation does not separate the conditions usefully:**
  mean CV **0.156** for independently-estimated per-view 2D against **0.150** for the
  proofread 3D over 700 session × edge pairs — a 3.7% relative reduction, consistent in
  sign (lower on 613 of 700) but far too small to use as a consistency metric, because
  at this scale bone length is dominated by animal deformation and most skeleton edges
  are long-range chords across a deformable body.
* **Panel a's own run contains one view outside τ.** From the two anchors, the anchor
  views reproject at 1.4–4.5 px and the other six at 2.5–24.6 px; of the 18 held-out
  measurements in that frame (6 views × 3 animals) exactly one, 24.6 px in
  `Camera3_sideC`, exceeds the 20 px tolerance the same figure uses as the accept
  threshold, i.e. it is a keypoint a labeller would nudge. This is the expected
  behaviour at p = 0.32%, not a counter-example, but it should not be presented as an
  all-accept frame.
* **Cross-view inconsistency of independent 2D is mild on this corpus** (median
  cross-view residual 2.58 px), so the "independent per-view labelling is geometrically
  inconsistent" argument cannot be made from these data. The contrast drawn here is
  two-anchor-and-accept versus label-every-view, both derived from the same
  observations; no human independently-labelled condition exists in any dataset here.
* **Placements, not time.** Wall-clock labelling time was not measured. Panel b reports
  manual placements, which is what the protocol changes, and the axis says so.

## Discussion, not caption

**Rig widening is an extrapolation and must stay out of the Results.** That a
physically wider rig would reduce two-view depth ambiguity follows from the geometry and
is consistent with panel d, but **no camera was ever moved**: all ten markers come
from one fixed 5-camera geometry, the pairs are not independent (they share cameras and
one calibration, so the effective n is well under 10), and the observed range is only
13–31°, so every wider rig is pure extrapolation off the end of the measured range. Two
further details are consistent with a single fixed geometry rather than a designed
sweep: 18.0° + 13.5° = 31.5°, exactly the 0–1 angle, so cameras 0, 2 and 1 are coplanar
with the animal; and the widest pair available, 31.5°, still sits on the steep part of
the 1/sin curve. The defensible statement in the Results is the annotation instruction
(pick the two most different directions); rig design belongs here.

*Reported for propagation elsewhere (not editable from this figure): the k = 1.87 mm
quoted in `README.md` is the plain least-squares fit, under which only 5 of 10 pairs
fall within ±25% — the "8 of 10" claim holds for the robust k = 1.52 mm used here, so
the two numbers cannot be quoted together.*

---

## Figure 3 — Cross-view association

> **PENDING A DATA REFRESH — panel e only.** `figs/out/fig3_sweep.json` still uses a
> fixed 6,000-frame leading window per cell, which is ~3% of a session and cannot carry
> a "the default sits on a plateau" claim; it is to be regenerated over the **full** 8
> BMimica sessions. `figs/panels/fig3_05_sweep.py` reads every sweep quantity from the
> JSON — including both plateau thresholds — so the artwork will be correct the moment
> the new file lands and needs no edit. **The panel-e numbers quoted in this caption are
> from the windowed run and must be re-read off the regenerated figure before
> submission**: the absolute switch counts scale roughly with frame count (~30×) and the
> two plateau thresholds may move. Nothing else in Fig 3 or in Fig 7 depends on that
> file. Until it lands, the figure's own footer states the 6,000-frame window and this
> caption must not say "full sessions".

**Greedy per-camera Hungarian assignment chooses the same grouping as exhaustive
hypothesis enumeration on 137,264 of 137,266 eligible frames, at 10⁷× lower cost in the
configuration where enumeration becomes intractable.**
(**a**) The two strategies, drawn as the two shapes of the search rather than as their
answers. Exhaustive hypothesis testing (Maree et al. 2024) enumerates every grouping of
detections into identities — `A!` per view, `(A!)^C` per frame for `A` animals and `C`
cameras — triangulates and reprojects each, and keeps the one with the lowest
reprojection error; the grid is that hypothesis set with the winner filled. LUC3D solves
one Hungarian assignment per camera, committing that camera's assignment to the running
set of 3D targets before the next camera is solved, at O(C·A³) — a chain of C solves,
not (A!)^C hypotheses.
(**b**) The cost LUC3D minimises for each (target, detection) pair, printed verbatim: a
2D term on the distance between the detection and the target's reprojection into that
view, decayed by the target's age, and a 3D term on the perpendicular distance from the
target to the detection's back-projected ray. Each term is drawn in the space it lives
in — the 2D term in one image plane, the 3D term in space — with the bare extrinsic
`[R|t]` as the projection matrix and normalised camera coordinates throughout. Schematic
of `pose/tracker.js`; it carries no numbers deliberately, because it is a definition and
not a measurement.
(**c**) Hypotheses per frame for the exhaustive method, one curve per rig size, exact
arithmetic; the dotted rule is the harness's own 10⁶ hypotheses-per-frame cap. This axis
carries **only** the exhaustive count: the greedy solve enumerates no hypotheses at all,
so its cost is stated in words under the axis and measured in **d**, not drawn as a
second curve here.
(**d**) Measured LUC3D association time per frame across rig sizes, one series per animal
count (`scripts/bench/bench_crossview.mjs`). **n = 1 session per line** — 2 animals
`10072022131531`, 3 animals `10072022142111`, 4 animals `10072022145420` — so the
separation *between* lines confounds animal count with session; what the sweep *along* a
line isolates is C, because the detection pool is identical across the camera-subset
cells of a given animal count. The one open marker is a second corpus measured at the
same (2 animals, 5 cameras) cell (BMimica `20250827_141755`, 1.12 ms against the
SLAP-2M line's 0.96 ms); it is drawn at its own value rather than averaged away, because
averaging would invent a third number that was never measured. Worst case on the panel is
**2.4 ms per frame** at 4 animals × 6 cameras, 8× under a 20 ms per-frame budget at
50 fps.
(**e**) An ablation **of LUC3D against itself**: the two cost weights swept over 24
(corr2d, corr3d) combinations, which collapse *exactly* onto their ratio
r = corr3d/corr2d — every pair of cells sharing an r returns identical IDF1 and
identical switch counts. Cross-view IDF1 (right axis) and summed within-view ID switches
(left axis, log scale). **The sweep is one-dimensional in r and does not select 6.** It
shows that the 3D term must be switched on and where each metric stops improving; the
shipped r = 6 is marked because it is the default, not because the sweep picked it.
(**f**) Measured wall-clock time per frame for both methods on identical detections, over
the four configurations that could be attempted, on a log axis from 1 ms to 1 day; the
title carries the partition-agreement rate and both frame counts. The 4-animal,
6-camera point (1.9 × 10⁸ hypotheses per frame, above the harness's 10⁶ cap, **zero
frames computed**) is drawn as an **open marker — this figure's convention for "not
measured"** — at the extrapolated ~66,343 s per frame, with a range bar spanning the
244–347 µs per-hypothesis rates that were measured.

*Methods.* Cost is summed over nodes k with per-node weights wₖ (wₖ = 0 drops a node
from the association entirely) and negated, so the Hungarian solver minimises it. Both
thresholds are soft — exceeding one drives its term negative rather than gating the pair.
Shipped defaults are corr2d = 1.0 and corr3d = 6.0 (r = 6). IDF1 and raw ID-switch counts
are computed with motmetrics; every method receives the identical identity-stripped
detection pool, so the comparison isolates association from detector quality. **The
exhaustive method is our reimplementation of the published per-frame procedure, not the
authors' code.** It is undefined on any frame where a camera does not detect exactly `N`
animals, because `A!` per view is then ill-posed: of **198,292** frames considered,
**137,266 (69.2%)** were eligible and **61,026 (30.8%)** were skipped and counted, not
silently dropped (per-configuration eligibility 68.2 / 79.2 / 80.5%). Panel **e** is 8
BMimica sessions on a fixed **6,000-frame leading window per cell**, identical across all
24 cells (~3% of a session; see *Pending* above — the artwork's own footer states the
window).
Panel **f**'s extrapolated point uses **347 µs per hypothesis**, the rate measured on the
largest configuration that ran (3 animals × 5 cameras): 1.9 × 10⁸ × 347 µs ≈ **66,343 s
per frame**. The bar on that marker spans the full 244–347 µs range the measured
configurations give (46,587–66,343 s per frame). Panel **d**'s and panel **f**'s LUC3D
times come from the same `fig3_runtime.json measured` table, matched to each
configuration by (animals, cameras) **and corpus** rather than averaged — the (2, 5) cell
was measured twice on two corpora and the exhaustive 2 × 5 run is BMimica, so the BMimica
LUC3D measurement is the one set beside it.

**The intractability claim does not rest on 347 µs.** Our exhaustive is a single-threaded
JavaScript reimplementation, so an optimised C++ or GPU implementation could plausibly be
two orders of magnitude faster. That would still leave **~11 minutes per frame** at
4 animals × 6 cameras, so the statement that survives any implementation is that the
configuration is intractable — not that 347 µs is the true per-hypothesis cost. Two
further points a reader should have: the 347 µs rate comes from the **shortest** of the
three runs (161 frames, because each frame there costs 7,776 hypotheses), while the two
better-sampled configurations (122,830 and 14,275 frames) give 244–254 µs; and the rate
was measured at **5** cameras and applied to a **6**-camera configuration, where each
hypothesis must triangulate and reproject across one more view, so the extrapolation
understates exhaustive's cost rather than inflating it. Panel **f**'s configurations stop
at C = 6 because the shared 8-camera detection pool does not exist — side and sideL are
only available as raw per-session `.slp` in a non-overlapping session subset, and using
them would mean scoring on a different detection pool from every other point.

*Supplementary Note.* **The agreement rate in panel f's title is an agreement result, not
a win.** Greedy and exhaustive choose the same partition of detections on 99.9985% of
eligible frames; the claim is that a cheap method loses nothing, not that it is more
accurate. (For completeness, on the same frames greedy scores IDF1 0.982 with 2 switches
against exhaustive's 0.714 with 76, but that gap is an artefact of the comparison rather
than a result: the published method is purely per-frame with no temporal mechanism, so to
make IDF1 computable for it at all our implementation threads identity across frames by
nearest-3D-centroid matching to the previous computed frame. That threading is not part
of the association decision. The partition agreement is the clean, threading-free
comparison and is the number we report.)

**The response in panel e is flat in the ratio, not in the 3D weight, and the sweep does
not single out r = 6.** *(Values in this paragraph are the windowed run — see PENDING at
the top; the structural claim is what matters and the thresholds are derived from the data
on the artwork.)* The axis is one-dimensional because only the ratio matters: all 24
(corr2d, corr3d) cells collapse exactly onto r, verified rather than assumed (r = 1 gives
IDF1 0.9518 and 14 switches whether the cell was 0.5/0.5 or 1/1). What the sweep supports
is that **the 3D term must be on**: with it switched off entirely (r = 0) the same tracker
gives its worst IDF1, 0.862, and 1,329 switches. Beyond that the two metrics saturate at
different points, which is why both axes are drawn — IDF1 reaches its plateau value as
soon as the 3D term merely matches the 2D term (0.9518 at r = 1 and at every r above it),
while the last ID switches need the 3D term to *outweigh* the 2D term 2:1 (14 switches at
r = 1, 2 at every r ≥ 2). A claim that the response is "flat for any 3D weight ≥ 1" would
be false: at corr2d = 2, corr3d = 1 the 3D weight is 1 but r = 0.5, and IDF1 is 0.9401
with 100 switches. The shipped r = 6 is drawn because it is the shipped default; it sits
past both knees inside a plateau that extends to the end of the swept range (r = 24), so
it is a safe default rather than a value this sweep selected or tuned. Nothing here
recommends 6 over any other r ≥ 2, and the caption must not say the sweep chose it.

`pose/cross-view-tracker.js` is a port of Maree's *temporal* CrossViewTracker, a different
component from the annotation-time association compared here. Credit for both the
exhaustive method and for naming the greedy alternative as future work belongs to
Maree et al. 2024.

---

## Figure 4 — Triangulation

> Every number below is printed by `python3 figs/fig4.py` as `[caption]` lines, read
> straight from `figs/out/fig4.json` and `fig2.json`, so the caption can be checked
> against that output rather than trusted.

**The accuracy of a triangulated keypoint is set by how many views contribute and by
whether a badly-fitting view is rejected — 4.75 → 1.22 mm as views go from two to five,
and a median 7.2 mm displacement from dropping one view that disagrees by ≥ 10 px — not
by the choice of solver, which moves the residual by 8% on the views it optimises and
3% on a view it has never seen.**

(**a**) The three solvers. Linear DLT minimises an algebraic error in ideal-pinhole
coordinates in closed form and is the app's default. The app's non-linear
triangulation minimises a geometric error in each camera's native, still-distorted
pixels (soft-L1 followed by an L1 polish phase) with the cameras held **fixed** —
which is why it is triangulation and not bundle adjustment, although the app's menu
labels it "Bundle Adjustment". True joint bundle adjustment, which frees the cameras
as well as the structure, exists in the codebase (`bundleAdjustCameras`) and is
deliberately not wired to the UI, because rewriting a project's calibration
invalidates every 3D point already derived from it. Padlocks mark cameras held fixed;
arrows mark cameras free to move. Schematic, not data.
(**b**) Median 3D distance to the fully-informed proofread reconstruction when the
point is triangulated from *k* of the five views (all C-choose-*k* subsets, solver held
constant), median over 50 sessions; band p25–p75 — a median *of* the per-session IQRs,
not a confidence interval. 4.75 / 2.91 / 1.92 / 1.22 mm for 2/3/4/5 views. **This panel
alone reads `fig2.json`** (DLT only, stride 200, 1,277,424 keypoints), whereas c–f read
`fig4.json` (both solvers, stride 60, 4,253,636 keypoints); the figure's footer states
both samplings.
(**c**) Distance the 3D estimate moves when the single worst-fitting view is dropped
and the point re-solved from the rest, by how far that view sat from the all-view
solution. Median 1.07 mm (< 3 px, n = 1,167,554), 1.76 mm (3–10 px, n = 3,019,181),
7.18 mm (≥ 10 px, n = 66,901); boxes p25–p75, whiskers p5–p95, **box width ∝ √n**
because n differs 45-fold and three equal boxes would read as three equal conditions.
Each stratum's **share of the keypoints** is printed under its tick (27% / 71% /
**1.6%** — so the 7.2 mm headline is 1.6% of the data, not a typical value), and so is
the **fraction where the drop actually lowered the kept views' error** (87% / 83% /
96%), because a displacement has no sign and the magnitude alone is equally consistent
with the drop fixing the point and with it wrecking it. No reference 3D enters this
measurement.
(**d**) Leave-one-camera-out: solve from *k* of the four remaining views, project into
the fifth, and score against the raw detection there. Medians over 1,417,879 keypoints
(every third keypoint, one held-out camera each). 3.92 / 3.36 / 3.06 px for DLT at
2/3/4 views. Lower strip is refined − DLT; each bar takes the winning solver's colour.
(**e**) Median reprojection error per session (one dot per session, joined in pairs;
rules are the median of the 50 session dots, not of the pooled keypoints). Left, scored
in the cameras the solver used — labelled **(enforced)** on the artwork, because the
refinement minimises the reported metric and a backtracking guard vetoes any step that
raises it, so "refined lower in 50/50" there cannot come out otherwise. Right, scored in
a camera it never saw, where either solver can lose: refined is lower in 34/50.
(**f**) Solve time per keypoint for the two shipped paths, measured in this run
(single-threaded Node 26, `performance.now()` around each call).

## Findings

* **View count dominates.** 4.75 → 1.22 mm, a **3.9×** reduction, and the same
  direction reference-free in (d): held-out error 3.92 → 3.06 px from two to four
  contributing views. The px effect is smaller than the mm effect because held-out
  reprojection error has a floor set by the detector's own noise in the held-out view,
  which no solve can remove.
* **One bad view has real leverage.** Where the worst view disagrees by ≥ 10 px,
  rejecting it moves the point a median **7.2 mm** (p95 26 mm) — about 11% of the
  64.5 mm median nose-to-trunk length measured for Fig 6. That is what the app's
  `reprojErrorThreshold` control changes.
* **Solver choice is a small effect, and out of sample it is small and conditional.**
  On the views it optimises, the refinement lowers the median residual 2.35 → 2.15 px
  per session (pooled 2.245 → 2.056 px, **−8.4%**). On a held-out view it lowers it
  3.33 → 3.14 px per session (pooled 3.051 → 2.971 px, **−2.6%**; paired per-session
  median −0.123 px, 95% bootstrap CI [−0.138, −0.086]; lower in **34 of 50** sessions;
  better on **53.1%** of 21,268,180 held-out views). **The sign reverses at two
  views**: with only two views in the solve the refinement is *worse* out of sample
  (3.92 → 4.06 px). So the refinement is worth its 6.9× cost when views are plentiful
  and should not be trusted to improve a two-view solve.
* **A software-validation note, deliberately NOT a panel.** An earlier option set in the
  app (`robustScale: Infinity`, `polish: false`, `guard: false`) raised the *displayed*
  reprojection error above the DLT value it started from on **24.6%** of keypoints
  (1,048,210 of 4,253,636), by a median of **+0.026 px** (p99 +0.300 px). This was drawn
  as a panel in an earlier draft and has been removed: it is a changelog item about a bug
  already fixed, it named an internal issue number on the artwork, and "change in the
  displayed error" is not a quantity a reader of this paper can act on. The number is
  kept here because it is the evidence that the guard in the shipped solver does
  something, and `figs/fig4.py` still prints it as a `[caption]` line.
* **The fix removed a frequent but tiny inconsistency, not an accuracy defect.**
  The pre-#113 option set raised the *displayed* error above the DLT it started from on
  **24.6%** of keypoints (1,048,210 / 4,253,636), by a median of only **0.026 px**
  (p99 0.30). The shipped set lowers it by a median 0.146 px and never raises it.
* **Between-session spread, for the panels that pool keypoints.** Held-out
  refined-minus-DLT difference per session −0.339 to +0.073 px (median −0.123);
  refined wins 45.3%–61.0% of held-out views per session; the pre-#113 regression rate
  is 12.9%–39.3% per session (median 23.1%). So the direction of every pooled statement
  above is the majority direction across sessions, not an artefact of pooling — but
  none of them is unanimous, and the caption says so rather than quoting the pooled
  number alone.

## What this figure deliberately does not claim, and why

* **"Refined is never worse than DLT" on the views it optimised is enforced, not
  measured, and is not offered as a result.** Phase 2's loss *is* the reported metric,
  and a backtracking guard returns the DLT seed outright unless the candidate's
  reported error is ≤ the seed's (`triangulation.js`; the refined point came back
  bit-identical to its DLT seed on 0 of 4,253,636 keypoints, so the guard never had to
  fall all the way back). Panel e's
  left group therefore *cannot* come out any other way; the artwork prints
  "refined lower in 50/50 (enforced)" under it, and it is shown only to give the size of
  the in-sample effect beside the out-of-sample one, which either solver can lose and
  does ("refined lower in 34/50" under the right group). **The distribution of the signed
  change in the app's *displayed* error, which an earlier draft drew as its own panel, is
  no longer on the artwork** — the figure has six panels, a–f, and f is solve time. The
  numbers that panel carried are kept in *Findings* below and printed by `fig4.py` as
  `[caption]` lines; do not cite a panel for them.
* **No 3D-accuracy comparison is made between solvers, and none is available from this
  corpus.** The proofread reference's own native-space reprojection error is
  **2.406 px**, higher than DLT's 2.245 and the refinement's 2.056 — so the reference
  is not the minimiser of reprojection error on these detections. Distance to a
  reference that sits *further* from the data than either candidate rewards whichever
  candidate moved less, which is DLT by construction, and cannot arbitrate between two
  methods that differ precisely in which error they minimise. `fig4.json` carries that
  comparison as `by_worst_view`, labelled a diagnostic; `fig4.py` does not read it.
  Ranking these solvers in 3D needs a real ground truth — synthetic points or a
  calibration object, as the branch's own unit tests use.
* **Panel b's 5-view point is a floor, and the 3.9× is a lower bound — but not for the
  reason an earlier draft gave.** At *k* = 5 the solve uses the same views the reference
  pipeline did, and the median is 1.22 mm. That number is close to the RANSAC-Procrustes
  residual (1.20 mm), but **the two are the same measurement on different frame subsets**
  ("our all-camera DLT of the per-camera 2D against the proofread 3D"), so their agreement
  is near-tautological and is *not* evidence that frame-alignment error sets the floor —
  the fit is good, at 97–98% inliers. The floor is instead genuine disagreement with an
  external reference, absorbing the 2D detector's error and whatever human 3D correction
  the proofread pass applied. That still makes 3.9× a lower bound, because the denominator
  carries those errors and cannot go to zero, but the mechanism is reference error rather
  than a bad alignment. Panel d is the version of the same effect that needs no reference
  at all, which is why both are shown.
* **This dataset does not exercise the robust loss as designed.** Only 66,901 of
  4,253,636 keypoints (1.6%) have any view off by ≥ 10 px, against the 60 px gross
  outliers the branch's own tests inject; the 11–18× advantage those tests report under
  a gross outlier should be quoted from them, not re-derived here.
* **Panel c's boxes are a sensitivity, not an improvement, and the two are kept apart on
  the artwork.** Dropping the worst-fitting view lowers the error in the *views that
  remain* almost by construction, so that quantity is not what the boxes plot: the boxes
  are the displacement in millimetres, which nothing guarantees. The direction is
  supplied separately, as the printed "% better" (`robust.*.improved_frac` = 87 / 83 /
  96%) — one solver, one camera removed, scored on the kept views' own detections. It is
  not a comparison between solvers and it needs no reference 3D.

## Provenance

All panels come from the **same 50 BMimica sessions** (5 cameras, 2 mice, 15 nodes,
6 recording dates, **3 distinct calibrations** — the rig was recalibrated between
dates, and every session is kept by keying intrinsics per session rather than
discarding sessions that disagree). Panels c–f use **4,253,636** keypoints matched in
all five views at frame stride 60; panel b uses **1,277,424** at stride 200 from the
same sessions. Median lens-distortion displacement **8.42 px** (p95 23.36, over
1,012,775 sampled detections), so the native-versus-ideal-pixel distinction the solvers
differ on is real on this rig. Solvers are the production functions from the
`eric/bundle-adj` worktree's `pose/triangulation.js`, imported read-only.

## Corrections to the previous version of this caption

| was | now |
|---|---|
| "lowers reprojection error by 6%" | **8.4%** in sample (2.245 → 2.056 px) |
| "held-out DLT 2.27 vs refined 2.35 px" — refinement does not generalise | superseded: that was **one** session. Over all 50, **3.051 → 2.971 px**, refinement slightly better, lower in 34/50 sessions — but worse at two views |
| "pre-#113 regression rate (35% of keypoints)" (artwork printed 39%) | **24.6%**, and with its magnitude: median +0.026 px |
| "median lens-distortion displacement 4.6 px" (in no data file) | **8.42 px**, deposited as `distortion_px` in `fig4.json` |
| n = 1 session, 1 calibration (footer's "1 session(s)" was a `.get()` default) | **50 sessions, 3 calibrations**, written explicitly as `n_sessions` / `n_calibrations` |
| panels a–c from 1 session, panel d from 50 via `fig2.json`, unflagged | all panels from the same 50 sessions, stated in the footer |

**Why the one-session run was so misleading.** `fig4_export.py` defaults to
`--sessions 1`, which takes `sorted(sessions)[0]` = `20250827_141755`. Of all 50
sessions that one turns out to be the **extreme** on both of the figure's headline
metrics: the *lowest* fraction of held-out views the refinement wins (0.4525, corpus
range 0.453–0.610) and the *highest* pre-#113 regression rate (0.391, corpus range
0.129–0.393). It is also on calibration 0, which only 7 of the 50 sessions share. The
choice was arbitrary rather than selective, but it produced the two numbers that most
favoured a "the refinement does not generalise / the fix was critical" reading, and
both moved substantially once the corpus was used. This is the concrete cost of the
n = 1 pseudo-replication, and the reason the figure now states its n on the artwork.

---

## Figure 5 — Proofreading

**Ranking keypoints by cross-view reprojection error — a number the app already has and
that needs no ground truth — recovers 27% of the total correction a proofreader would
have to make from a 10% review budget, against 10% for reviewing in random order
(2.7-fold) and 12% for ranking by detector confidence, and reaches 85% of what an oracle
with the answer achieves (32%).**

(**a**) What LUC3D reports for the frame you are on, in three parts. **Left tile**, the
whole frame as the app draws it (cam 0 mid), all three animals, all overlays. **Middle
tile**, the same frame magnified on the single (view, animal) with the largest residual
among the exported views — cam 4 topR, animal 2, **16.8 px**: it is half-occluded by the
arena trough, and two of its nodes reproject ~17 px from where the detector put them
(white circles, red error vectors). The key beneath decodes the overlay (solid =
detected, dotted = reprojected from the 3D, red = the error). **Right**, grouped bars —
not a line, because cameras are a categorical axis — of the app's own per-view
reprojection error for each of the three animals in that frame, from a normal all-views
solve. The animals are labelled 0–2 as the app names them. Two sit at 2.5–5.3 px in every
view; the third sits at 9.1–16.8 px in every view (mean 12.1 px against 3.3 and 3.2), so
the number identifies which animal to look at before anyone has looked, and the
(view, animal) shown magnified is computed from the manifest rather than chosen by hand.
One frame, three animals, eight cameras — an illustration of the readout, not a corpus
statistic; the corpus statistics are **c** and Fig 6c.
(**b**) The loop LUC3D supports today: triangulate everything, read the per-node,
per-view error for the frame you are on, fix it, re-triangulate that frame, export. The
bracket marks the three stages that happen **one frame at a time**, and there is
deliberately **no ranking box**, because the app has no ranked worklist — which is the
limitation **c** and **d** quantify.
(**c**) Share of the total correction distance recovered against the fraction of
keypoints reviewed, reviewing worst-ranked first, under three rankings — the cross-view
residual, the detector's own confidence, and an oracle that ranks by the true correction
distance. The diagonal is review in random order. Values at the 10% budget are labelled.
(**d**) The same 10%-budget comparison per session: the residual beats detector
confidence in **74 of 74 sessions** (two-sided sign test *p* = 1 × 10⁻²²; residual
21.4–44.5%, confidence 9.2–16.6%), so the pooled curve in c is not an average hiding a
split corpus.
n = 74 SLAP-2M sessions, 1,561,915 keypoints, 6 cameras used per session, frames
uniformly strided every 120. Spearman ρ = 0.69 between the residual and the true
correction distance per keypoint (per-session range 0.53–0.81).

## What the ranking is, and is not

**The ranking is a property of the signal, not a feature of the software.** LUC3D reports
the reprojection residual per node and per view for the *current* frame (Instance Info ▸
error breakdown, `ui/info-panel.js`). It has no ranked worklist, no sort, no filter, no
error-coloured timeline and no worst-frame navigation — the breakdown is even ordered
alphabetically on purpose, for a stable reading order across frames — so panels c and d
are an offline measurement of what such an ordering would buy, not a demonstration of a
shipped tool. A ranked worklist is a natural extension and is the obvious use of this
result. (The one place the app acts on the residual by itself is the optional robust
triangulation threshold, which *drops* a high-error view inside the solve; it does not
order anything for review.)

**The measurement is not circular.** The quantity being recovered is the real correction
distance — how far a raw detection sits from the proofread answer, which requires the
answer — while the ranking uses only the cross-view residual, which does not. Ranking by
the residual and then reporting recovered *residual* would prove nothing.

## Honest limits

**Confidence is barely better than random, so the "2.3× confidence" framing flatters the
result and the panel gives both baselines.** Detector confidence recovers 11.7% at a 10%
budget where random order recovers 10.0%; the residual's 27.0% is 2.3× confidence but
2.7× random, and random is the baseline that matters.

**Most of the correction is unreachable at a small budget, by any ranking.** The oracle
itself only reaches 31.8% at 10%, i.e. **68% of the needed correction lies outside a 10%
review budget even for a ranking that knows the answer**. That is a property of the
corpus, not of the residual: the correction is spread over many mildly-off keypoints
rather than concentrated in a few catastrophic ones.

**A keypoint that is wrong in a way every camera agrees on is invisible to this signal**,
which is the other reason the oracle line sits well below 100%. This failure class is
real and measured, not hypothetical: in the failure-mode taxonomy over 42 SLAP-2M
sessions (681 episodes, 195,465 mislabelled frames), `CROSSVIEW_LOCK` — an identity
locked wrongly in ≥3 cameras at once, hence geometrically self-consistent — accounts for
**36 episodes (5.3%) but 18.2% of all mislabelled frames, median duration 578 frames**.
Reprojection residual cannot see it; it is exactly the case that needs a different
signal.

**The reference is the proofread 3D reprojected into each camera**, so "correction" means
agreement with the proofread answer, not absolute accuracy, and the reference carries its
own reconstruction error. Raw detections come from the benchmark's shared
identity-stripped pool (filter-only, no tracking; 5 detections per frame, score-ordered)
and are assigned to reference animals per frame per camera by mean keypoint distance —
so a detector identity swap appears as error rather than as a swap.

**Cross-view identity for the triangulation is taken from that same reference match, so
association is assumed already correct.** This measures the residual's value for finding
bad *keypoints*, not bad *identities*; association is the separate step (Fig 3) a user
runs before proofreading.

**Panel a and panels c/d are different corpora**, stated on the artwork: a is one frame
of the 8-camera HardFight recording driven through the real app (the only session built
as an app session with a calibration), c and d are 74 SLAP-2M sessions. Nothing in a
enters c or d.

---

## Figure 6 — Datasets

**Across the 74 proofread SLAP-2M sessions, the corpus's own difficulty rating acts on
*whether* a keypoint is detected rather than on *how well*: the per-view miss rate rises
10.9-fold from the easiest to the hardest stratum (5.3% → 57.9%) while the mean error of
the detections that do fire rises 1.29-fold (3.67 → 4.72 px). A keypoint missing in one
view is recoverable from the others; a keypoint degraded in every view is not.**
(a) The rig as LUC3D renders it — all eight SLAP-2M cameras with the frame's own
reconstructed animals inside them — cropped to the render's measured content bounds, with
the boxed cluster of four animals **magnified side by side** at the right and joined by
leader lines. Badges: `8 cameras`, `6 proofread`, `4 in 3D`, `magnified`. No scale bar:
these are perspective views of a scene spanning a large depth range and the viewport's
field of view is not recorded, so no single bar would be correct — b's bars are the
figure's metric referent.
(b) One frame across the six proofread cameras, cropped to the app's own per-view
bounding box over the frame's instances, instances coloured by identity; **50 mm scale
bars**, computed from the calibration in the fronto-parallel plane through the animals.
(c) Raw per-camera detection quality against the difficulty rating, in **three sub-plots
because the three quantities disagree**: keypoints missing (rises 10.90×), error of those
present (**mean** ± s.d. between sessions, with the 95th percentile — the panel names the
statistic on the artwork; the mean rises 1.29×), and the fraction beyond the app's own
20 px reprojection tolerance, as labelled bars (rises 5.34×). n per stratum is printed
under the row.
(d) The animal-count control for c: the same miss rate against difficulty, re-run
**within** each animal count. All four counts and all 74 sessions enter (1 animal n = 32,
2 animals n = 35, 3 animals n = 4, 4 animals n = 3), colour is an ordinal ramp on c's
miss-rate hue, error bars are ±1 s.d. between sessions where n > 1, and cells resting on a
single session are drawn **hollow** so they cannot be read as measurements. A count
occupying fewer than three difficulty ratings gets bare markers and no connecting line
(3 animals occupies only ratings 3 and 7). The marginal miss rate by count alone is
printed under the axis and is **non-monotone** — it falls at four animals.
(e) Corpus composition, transposed (attributes down, corpora across); the last **row**,
"Measured in c, d, f", marks which corpus those panels measure, and the SLAP-2M camera
cell reads `8 (6 proofread)` because every SLAP-2M measurement in this paper uses six.
(f) The measured strata, per difficulty: sessions, keypoints, the **set** of animal counts,
the black/white bedding split, error mean, p95 and p99, and the fraction beyond 20 px.
The animal-count and bedding columns are where a reader can check the confound d controls
for; the error column is the **mean**, the same statistic c plots and the headline quotes.

n: panels c, d, f are **74 SLAP-2M sessions, 1,561,915 keypoint comparisons**, six
cameras, 15 nodes, frames uniformly strided at 120 (≈16,300 of 1,954,440). Panels a and b
are one further SLAP-2M session (difficulty 4, four animals, black bedding). The
130-session, 12,039,174-frame corpus figure in (e) is a **composition** statement: the
56 BMimica sessions carry 84% of that frame count and enter no other panel.

## Methods

* **Raw detections, not proofread labels.** The detection pool is the benchmark's shared
  identity-stripped SLEAP output (`keeptrack_h5s/{cam}_predictions.h5`, whose attrs read
  `source = "filter-only detections (no tracking)"`), five detections per frame ordered
  score-descending, indexed by row into `detections_only_master_sheet.tsv`. The master
  sheet's `*_inference_h5` columns all point at *proofread* files, so using them would
  compare the proofread data against itself.
* **Reference.** The proofread 3D reprojected into each camera, which is
  identity-consistent across cameras by construction. Detections are assigned to
  reference animals per frame per camera by mean keypoint distance (unmatched beyond
  60 px), so a sustained detector identity swap appears as error, not as a swap.
  "Missing" means the reference has a keypoint in that view and no matched detection
  covers it.
* **Summaries.** Points are means across the sessions in a stratum, error bars the s.d.
  *between* sessions, so no single session can carry a trend. Table values are the same
  session-level means.
* **Panel d.** Difficulty is confounded with animal count, so the trend is re-run inside
  every count. Difficulty survives the control: within the 32 single-animal sessions the
  miss rate runs 5.3% → 16.8% across ratings 1–5, and within the 35 two-animal sessions
  10.7% → 58.1% across ratings 2–7. And at *matched* difficulty more animals is worse —
  at rating 4, 12.4% / 19.0% / 39.6% for 1 / 2 / 4 animals. So c is neither a pure
  difficulty effect nor a pure animal-count one, and the panel says so. Marginally, miss
  rate by animal count is 12.4% (1), 33.2% (2), 45.0% (3, n = 4) and 39.6% (4, n = 3):
  non-monotone, falling at four animals, whose three sessions are all at difficulty 4, so
  that marginal is as much a difficulty average as an animal-count one.
* **Which deposit panel d reads, and why it is not the other one.** `fig6_detections.json`
  (74 sessions, `detections_only_master_sheet.tsv`, stride 120, the shared
  identity-stripped **raw detection** pool) — the same measurement c and f plot, so d is c
  stratified differently. `fig6_difficulty.json` also deposits a `by_animals` table and
  disagrees by half on the two-animal miss rate (21.95% against 33.19%), because it is a
  different measurement over a different population: 42 sessions, stride 100, no detection
  pool at all, comparing the proofread labels against the reprojected proofread 3D. The
  gap is itself informative — the raw detector misses ~50% more keypoints on two-animal
  sessions than that residual path suggests, which is what you expect when a detection
  that never fired is invisible to the residual.
* **Scale bars (b).** 50 mm in the fronto-parallel plane through the animals — a
  perspective image has no single scale, and this is the scale where the content is.
  Computed from the calibration with the app's own projection (distortion included) by
  displacing the frame's 3D centroid ±25 mm along two directions perpendicular to that
  camera's viewing ray: 1.07–1.20 px mm⁻¹ across the six views, anisotropic by ≤1.2%.
  Independently reproduced from the corpus 3D through OpenCV to within 0.31%. The
  calibration's length unit is millimetres: camera standoff 0.63–0.80 m and a per-animal
  3D extent of 234 mm (median; 244 mm in the corpus reconstruction).
* **Colour.** Identities are drawn in Okabe-Ito by the app itself (the stock palette's
  pure green/cyan/magenta collapse under deuteranopia). Per-view brightness is a display
  gain applied identically to every tile.
* Panel a shows all eight cameras of the SLAP-2M rig; only six carry proofread labels and
  only those six are measured. BMimica is a separate five-camera rig.

## Supplementary Note

* **Difficulty is the corpus's own hand-assigned rating**, not a measured quantity, and
  the strata are unevenly sampled (12/13/9/13/10/4/13 sessions). The rating is confounded
  with animal count — stratum 1 is twelve single-animal sessions, stratum 7 is twelve
  two-animal ones — which is why panel d exists and why panel f prints the animal-count
  and bedding composition of every stratum.
* **The "missing, not degraded" mode belongs to that rating, not to every difficulty
  axis.** Bedding is a counterexample, and it is **Fig 7b**, not a Fig 6 panel: black →
  white costs LUC3D 0.0116 IDF1, SLEAP 0.0792 and ByteTrack 0.1483 while the shared
  detector's recall barely moves (0.7300 vs 0.7262) — a difficulty axis that acts on
  *association*, not on detection. (All four are recomputed from
  `figs/out/fig3_trackers.json slap2m.by_bedding`, which is what Fig 7b plots, and
  **supersede** the 0.0071 / 0.7309 / 0.7274 quoted here from the bench sweep via
  `figs/REVIEW-hostile-pass2.md` — a caption cannot carry two values for one quantity.)
* **These are agreement with the proofread answer, not absolute accuracy.** The reference
  carries its own reconstruction error, and it comes from the pipeline that produced the
  labels being agreed with.
* **The tail is heavier than the mean implies**, which is why the mean and the 95th
  percentile are both plotted in c and the 99th is tabulated in f: across the strata the
  mean rises **1.29×** (3.67 → 4.72 px), the 95th percentile 1.40× (9.00 → 12.60), the
  99th 1.88× (14.52 → 27.36) and the fraction beyond 20 px 5.34× (0.34% → 1.83%).
  So the hardest sessions do not merely miss more keypoints, they also place a larger
  minority badly — but even that 5.34× is half the 10.90× rise in outright misses.
  **The statistic is the mean, and the panel names it** ("mean ± s.d."), because the mean
  is what the tail moves and the tail is the point. The median is deliberately not
  reported: it rises only 1.11× (2.89 → 3.19 px) and is the one summary that hides this.
  Both estimators are arithmetically right for their own statistic, so quoting the p50
  ratio anywhere in this figure's text would silently change estimator; `err_p50` stays in
  the deposited CSV and on no artwork.
* **Completeness of the 3D is assessed on a frame sample, not exhaustively** (stride 120).
* Panel a's 3D renders carry no scale bar: they are perspective views of a scene whose
  content spans a large depth range, and the viewport's field of view is not recorded, so
  no single bar would be correct.
* The identity assignment in (b) was checked against the corpus 3D: each of the four
  identities maps to the same corpus track in all six views (centroid agreement
  0.2–15.5 px), so the shared colours are the same animal across views.

---

## Figure 7 — Comparison

**On identical identity-stripped detections, LUC3D is the only method whose identities
survive being pooled across cameras: its IDF1 is unchanged from within-view to cross-view
scoring (0.749 → 0.749, drift ≤ 0.007 in every one of 50 sessions) while per-camera
trackers lose half to three-quarters of theirs, and its advantage does not depend on coat
or background contrast.**

(**a**) Within-view against cross-view IDF1 for four trackers over 50 full BMimica
sessions (5 cameras, 2 mice), drawn as a slopegraph — one line per tracker joining its
within-view mean to its cross-view mean, with the deposited 95% bootstrap CI over sessions
at both ends. Printed ratios are cross-mean ÷ within-mean. The dashed rule at
**1/C = 0.20 is a CEILING, not a chance level**, and the artwork says so at the rule.
Cross-view IDF1 pools all C cameras into one accumulator with one global identity per
animal, so a tracker that labels each camera independently can have its labelling matched
to truth in at most *one* camera and the other C − 1 necessarily carry labels that cannot
simultaneously be right: 1/C is the best such a tracker could score. Chance is set by the
number of **animals**, not cameras — with 2 mice a coin-flip cross-view assignment sits
near 0.5, far *above* where SLEAP (0.062) and ByteTrack (0.046) land. Reading 0.20 as
chance draws the *weaker* conclusion: landing below a ceiling is the stronger claim.
(**b**) Bedding invariance on the SLAP-2M corpus: IDF1 under black bedding (solid) against
white (open), with the shared detector's own recall as the fourth, grey pair — the control
that makes any drop the tracker's rather than the detector's. **Grouped bars, not a
slopegraph, because this is a between-session comparison**: `by_bedding` is 44 black
sessions against 30 different white ones, never the same session under two beddings, and a
connecting line would imply a pairing that does not exist. The animal-count composition
differs between the groups too (1 animal 21/44 black against 11/30 white), and the deposit
carries one pooled IDF1 per condition, so there are no intervals.
(**c**) The full within-view IDF1 distribution over 74 SLAP-2M sessions, as a survival
curve: the percentage of sessions scoring at or above each IDF1 threshold, one step per
session. Drawn this way rather than as three dot swarms because the trackers separate most
in the **upper tail**, which a median and a jittered cloud both bury — at IDF1 ≥ 0.9 the
counts are 36/74, 22/74 and 10/74. Per-camera-session win counts beneath (LUC3D 229,
SLEAP 173, ByteTrack 4, 38 of 444 tied), and both summaries the deposit asks for: LUC3D
within-view mean **0.736** against median **0.900**. Note this is a *different quantity*
from **a**'s "within view": that is BMimica, 50 sessions, 5 cameras, 0.749; this is
SLAP-2M, 74 sessions, 6 cameras.
(**d**) The paired per-session difference in within-view IDF1, LUC3D − SLEAP, by number of
animals in the session: mean with 95% bootstrap CI, and n and win count printed under
every tick. **The two rightmost cells are the two where LUC3D loses**, and their intervals
are wide because n = 4 and n = 3 — the CI is doing the disclosure that three plotted dots
would do badly. **The pooled +0.075 over all 74 sessions is carried by the 1-animal
stratum and is not a multi-animal result**, which the panel states on the artwork: 32 of
the 74 sessions contain one animal, where there is nothing to associate across views, and
that cell is both the largest effect (+0.141, 25/32, sign test P = 0.002) and 43% of the
corpus. Pooled over **≥ 2 animals it is +0.024 (n = 42, 23/42, sign test P = 0.64)** — it
does not clear a sign test — and the two cells where cross-view association should help
most are negative (3 animals −0.030, 0/4; 4 animals −0.028, 0/3).
(**e**) Error composition against a shared ground truth of 15,947,278 keypoint-instances:
false positives and ID switches as **exact counts**. False negatives are deliberately not
plotted — they are 98.8–99.3% of every tracker's error budget, so including them would
draw three identical bars and hide the terms a tracker controls; their share is stated in
the panel's footnote instead. LUC3D does not win on within-view switches (3,710 against
SLEAP's 3,608) and the panel does not pretend it does; ByteTrack's 12,305 is the 3.3×.
(**f**) Session-level within-view IDF1 against the shared detector's recall, one point per
session, with the IDF1 = recall diagonal. ByteTrack's correlation (**r = 0.780, R² =
0.608**) is printed but **its points are not drawn and cannot be**: the deposit's
per-session recall table has no ByteTrack column, and its per-session IDF1 is stored
sorted, so no point could be paired with its recall without inventing one. It is also the
one number that cuts against the panel's claim — "the level is set by detection" holds for
the two good trackers (LUC3D r = 0.975, SLEAP r = 0.949), not as a law.
(**g**) **The measured LUC3D disadvantage**: paired fragmentations per camera-session,
LUC3D − SLEAP, mean with 95% bootstrap CI over the 74 sessions, with the median drawn
beside it because the distribution is skewed (mean is 1.7× the median). **+24.0**
[+18.3, +30.0], median **+14.1**, and SLEAP fragments fewer in **72 of 74** sessions. A
fragmentation is not an ID switch: motmetrics counts one each time a tracked ground-truth
track becomes untracked and is later picked up again — the track breaks and resumes rather
than being reassigned to the wrong animal. For a proofreading tool that is a real cost,
and it is the price of the same conservatism that buys the cross-view result in **a**.

---

## Provenance

**Every SLAP-2M number in Figures 3 and 7 comes from one file,
`luc3d-bench/outputs/PAF_3d_kalman/_eval_baseline.csv`, and every cross-view number from
`luc3d-bench/outputs/bmimica/bmimica_crossview_all_eval.csv`. No other benchmark metrics
file is read.** This matters because `luc3d-bench/outputs/metrics/` contains three
mutually inconsistent runs under the single label "luc3d", and **none of them is the
shipped app**:

| file | LUC3D IDF1 | fragmentations | what it actually is |
|---|---|---|---|
| `metrics/per_camera_session_metrics.csv` (May 18 06:55) | 0.738301 | 7.27 | evaluation of `outputs/luc3d_results_v2/` — a **post-processed variant** |
| `metrics/by_tracker.csv`, `by_animals.csv`, `by_bedding.csv`, `by_camera.csv`, `session_wins.csv`, `session_pairwise.csv`, `worst_idf1_luc3d.csv` (May 18 01:55) | 0.736490 | 7.52 | aggregates of a **third** run whose per-camera file was overwritten and no longer exists |
| `metrics/auc_summary.tsv` (May 19) | 0.7383 | — | derived from the variant file above |
| **`PAF_3d_kalman/_eval_baseline.csv`** | **0.736035** | **28.11** | **evaluation of `outputs/luc3d_results/` — the SHIPPED defaults** |

`outputs/luc3d_results_v2/` was produced by re-running the tracker with
`outputs/luc3d_winner_params.json`: `applyUndercountVerifyClean`, `applyInterpolation`
(`interpMaxGap` 5), `uvMaxAcceptCost` 120, `uvMinMargin` 1.2. **Those options exist only
in the benchmark harness** (`luc3d-bench/scripts/luc3d_track_all.mjs`, opt-in via
`TRACKER_PARAMS`); grepping the LUCID source for any of them returns nothing. Plotting
them as "LUC3D" would credit the shipped tool with a post-processing pass it does not
have. `outputs/luc3d_results/` was produced with no `--params`, i.e. with the app's own
defaults, and is therefore the shipped configuration.

**Verified rather than assumed.** `luc3d-bench/scripts/evaluate.py`'s own `eval_camera`
was re-run over `outputs/luc3d_results/` and reproduces `_eval_baseline.csv`
**bit-identically** across all 1,332 rows × 10 metric columns (maximum absolute difference
0.0 on `idf1`, `idp`, `idr`, `num_switches`, `num_fragmentations`, `recall`, `precision`,
`num_misses`, `num_false_positives`, `num_objects`). `PAF_3d_kalman/metrics/headline.csv`
independently labels these numbers "LUC3D (baseline)", and its "LUC3D + PAF (L1 only)"
variant is 0.738089 — i.e. the 0.738301 in `outputs/metrics/` sits with the PAF variant,
not with the baseline.

For BMimica, `bmimica_crossview_all_eval.csv` was produced by
`scripts/bartul/bmimica_luc3d_real.py`, which drives **LUCID's own** headless bench driver
(`lucid/scripts/bench/bench_crossview.mjs`) at its default thresholds (`corr3dWeight` = 6)
— again the shipped code path, no post-processing. Cross-view IDF1 does not exist in the
SLAP-2M corpus, and only BMimica has a cross-view metric at n > 1, which is why the figure
uses two files: one per corpus, both the shipped configuration.

**Consequence for the numbers.** Every LUC3D figure quoted here is the shipped baseline
and therefore differs slightly from earlier drafts, which quoted the variant. The
camera-session win counts in panel **c** (LUC3D 229, SLEAP 173, ByteTrack 4, tied 38 of
444) are recomputed from `_eval_baseline.csv` and **replace** the 275 / 157 / 12 in
`metrics/session_wins.csv`, which is one of the stale 01:55 aggregates and reports no
ties. Similarly the pooled paired difference is **+0.075** (not +0.077) and the 3- and
4-animal cells are **−0.030** and **−0.028** (not −0.027 / −0.028).

**The PAF variants are variants.** `PAF_3d_kalman/` contains real improvements —
PAF + L1 + flip-revert reaches 6.19 switches per camera-session (−24% against SLEAP) and
L1 + tracklet-vote reaches 4.00 with IDP 0.958 — and they belong in Supplementary
material, clearly labelled as post-processing on top of LUC3D. They must never be plotted
as "LUC3D".

---

## Methods

Every tracker shown receives the identical per-frame detection pool with identity
stripped, so the comparison isolates association from detector quality. IDF1 is computed
with motmetrics. **Within-view** scores each camera separately, each with its own optimal
identity relabelling; **cross-view** pools all cameras into one accumulator with one
global identity per animal. A tracker with no cross-view association mechanism is
therefore bounded near 1/C on the cross-view metric (0.20 at C = 5, 0.167 at C = 6), and
that ceiling is a definitional consequence of the property being measured — it is why the
two metrics must be read side by side. The unit of replication is the **session**
throughout: per-camera rows are averaged to one value per session before any statistic is
taken, so a session does not count more heavily for having more cameras. CIs are 2 × 10⁴
-resample percentile bootstraps of the mean over sessions; P values are exact two-sided
sign tests (a Wilcoxon signed-rank with continuity correction is also recorded in
`figs/out/fig3_trackers.json` and agrees in direction throughout).

3D-MuPPET's `dmin` was retuned from the published 200 mm to 100 mm for mouse scale and its
detector replaced by the shared pool; what is compared is the published method's tracking
logic, not the shipped system. **UDMT is not in this figure**: it is off-pool (it brings
its own detector, so its score mixes detector and association quality) and the only
session it was run on is a single 4-animal SLAP-2M session. That session is recorded in
`figs/out/fig3_trackers.json` under `hard_session_slap2m` and plotted nowhere.

---

## Supplementary Note

**Read slope and height together, and do not over-read the 1/C line.** A flat line in
panel **a** means the method has a cross-view mechanism, and LUC3D is not alone in being
flat — 3D-MuPPET is equally flat (×1.00) but sits at IDF1 0.011, because a method
producing nothing consistent is trivially consistent. Flatness alone is not the claim.
Nor do the per-camera trackers "fall to" the 1/C bound: at C = 5 they land far **below**
it (SLEAP 0.115 → 0.062, ByteTrack 0.157 → 0.046, against 1/C = 0.20), so 1/C is a ceiling
on what a camera-local label could achieve, not a level anything reaches, and **not a
chance level** — chance for a cross-view identity assignment is set by the number of
animals (≈0.5 with 2 mice), which sits far above the rule, so "below chance" would be both
wrong and weaker than what the data supports. Note also that
ByteTrack's *within-view* IDF1 on this corpus is 0.157, numerically identical to the
cross-view IDF1 UDMT reaches on the one hard session — the two numbers are unrelated and
earlier drafts conflated them.

**LUC3D's flatness is small but not exactly zero.** Mean per-session ratio 0.9997
(95% CI [0.999, 1.000]); the largest |within − cross| difference in any of the 50 sessions
is **0.0070**, and a Wilcoxon signed-rank on the paired within − cross difference is
significant (P ≈ 5 × 10⁻⁷, normal approximation with continuity correction, n = 50). The
correct statement is "≤ 0.007 in every session", not "unchanged".
The corresponding collapse ratios are 0.484 [0.439, 0.532] for SLEAP per-camera and
0.286 [0.275, 0.297] for ByteTrack. LUC3D is ahead of every other tracker on cross-view
IDF1 in **50 of 50** sessions and on within-view IDF1 in **50 of 50** (exact sign test
P ≈ 1.8 × 10⁻¹⁵ each).

**Must be stated as a limitation: LUC3D does not lead on within-view IDF1 at higher animal
counts, and the n is small.** Paired per-session difference against SLEAP:
1 animal **+0.141** [+0.100, +0.184], 25/32 sessions won (n = 32);
2 animals **+0.035** [+0.008, +0.063], 23/35 (n = 35);
3 animals **−0.030** [−0.079, −0.005], **0/4** (n = 4);
4 animals **−0.028** [−0.050, −0.007], **0/3** (n = 3);
**≥ 2 animals pooled +0.024**, 23/42 (n = 42), sign test **P = 0.64**;
all 74 sessions **+0.075** [+0.049, +0.102], 48/74, sign test P = 0.014.
**The pooled +0.075 must not lead**: it is carried by the 1-animal cell, where there is
nothing to associate across views, so whatever produces +0.141 there is detection gating
and gap handling rather than cross-view association. In the stratum where the claimed
mechanism can operate the paired advantage is +0.024 and does not clear a sign test. The
≥ 2 figure is the n-weighted mean of the three deposited cell means,
(35 × 0.034964 + 4 × −0.030234 + 3 × −0.027937)/42 = 0.024262, so it can be checked by
hand against `fig3_trackers.json`; no bootstrap interval is quoted for it, because the
deposit stores each cell sorted and a CI recomputed here would not be the one the
generator produced — the exact sign test does not have that problem, which is why it is
the statistic given.
The direction of the 3–4 animal loss is robust in the sense that SLEAP wins every one of
those seven sessions individually, and we say so. But the load-bearing cells are **4 and
3 sessions** and they are confounded: all three 4-animal sessions are black bedding at
difficulty 4, and three of the four 3-animal sessions are black bedding. The claim of this
paper is cross-view identity consistency, not per-camera superiority.

**What within-view IDF1 actually measures (panel f), and why it bounds how much the
3–4 animal result can mean.** Across the 74 sessions, session-level LUC3D within-view IDF1
correlates with the *shared detector's* recall at **r = 0.975, R² = 0.95** (n = 74;
SLEAP r = 0.949, ByteTrack r = 0.780), and panel **e** shows why: against a common ground
truth of 15,947,278 keypoint-instances, detector false negatives are 98.8–99.3% of every
tracker's total error (LUC3D 5,649,855; SLEAP 5,509,232; ByteTrack 5,627,679). Two
consequences we state ourselves. First, MOTA cannot discriminate between these trackers —
it is dominated by a shared term — so excluding it is principled rather than convenient.
Second, at n = 4 and n = 3 with 95% of between-session variance attributable to detector
recall, the 3–4 animal difference is close to a measurement of the detector rather than of
the association method. Within that same shared error budget LUC3D produces the fewest
false positives — **34,240 against SLEAP's 62,320 (45% fewer) and ByteTrack's 51,049** —
at essentially equal false negatives.

**Bedding invariance is mechanistic because the detector is the control.** From black to
white bedding, within-view IDF1 falls by **0.012** for LUC3D, **0.079** for SLEAP and
**0.148** for ByteTrack (44 black / 30 white sessions), while the shared detector's recall
moves by **0.004** (0.730 → 0.726). The detector sees the same amount in both conditions;
what changes is appearance ambiguity, and only the methods that depend on appearance for
identity are damaged by it. Caveat: bedding is confounded with animal count (all three
4-animal sessions are black; 21 of 32 1-animal sessions are black).

**Two honest negatives.** (i) **LUC3D fragments more than SLEAP** — paired +24.0
fragmentations per camera per session, median +14.1, 95% CI [+18.3, +30.0], SLEAP fewer in
72 of 74 sessions, n = 74, Wilcoxon P ≈ 9 × 10⁻¹³. This is **panel g**, which exists
because the deposit's own caveat says it must ("Stated, not hidden") and because a figure
that prints every other loss of its method was silently dropping the one clean,
corpus-wide result that goes against it. Fragmentation and switching trade off: LUC3D ends
a tracklet where an appearance-based tracker would guess. (It fragments far less than
ByteTrack, 28.1 against 125.6 per camera-session — those two levels come from
`_eval_baseline.csv` and the ByteTrack run directly, not from `figs/out/`, so re-verify
them against the bench before submission; only the paired LUC3D − SLEAP difference is
deposited in `fig3_trackers.json` and on the artwork.) (ii) The corpus **mean** understates
LUC3D and hides
its shape — within-view IDF1 mean 0.736 against median 0.900 — because a minority of
sessions are detection blackouts. The distribution is the result: LUC3D clears IDF1 ≥ 0.9
on **36 of 74** sessions against SLEAP's 22 and ByteTrack's 10, and ≥ 0.7 on 45 against
40 and 24. The separation is largest in the upper tail, which is exactly what the mean
conceals.
