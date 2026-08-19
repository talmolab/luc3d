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
**a**, The SLAP-2M rig, rendered from one session's own data (Blender,
`blender-images/cage_scene.py`): the eight camera poses from the session's
calibration, the cage from its 24 measured corner coordinates, and the two
animals' tracked 3D poses from one recorded frame — nothing is hand-posed.
**b**, Pipeline, six stages from videos plus calibration to export. The three teal
chevrons and the bracket beneath them mark the stages contributed here: cross-view
re-identification, triangulation and 3D proofreading. The 2D detector is not ours —
per-view pose comes from SLEAP or any other predictor and LUC3D consumes `.slp`.
**c**, One frame
(frame 198) of an 8-camera, 3-mouse recording, 15-node skeleton. Left, the
per-camera SLEAP tracks the app is given; right, the same two views after
cross-view re-identification. Two of the eight views are shown: cam 0 mid, the
view reconstructed in **d**, and cam 7 sideR. Labels are the
track name (left, abbreviated on the artwork — `t89` is `track_89`) and the identity
(right, the app's `id_0`–`id_2` printed 1–3). Every detection carries its own label,
and the labels *are* the correspondence: no ellipse, ring or connector is drawn
between the two pairs. The animal labelled `track_89` in cam 0 and `track_83` in
cam 7 is one animal and becomes identity **1** in both, which is the collapse the
panel is about. Track colours are the app's arbitrary per-camera
track colours and carry no meaning across views — that is what the panel is about;
identity colours are shared by every view. Across all eight views the frame holds
**25 detections** carrying **21 distinct track names**, which resolve to **3
identities, each present in all 8 views** — 24 of 25 detections assigned, one per
animal per view; the 25th is a duplicate detection of an already-matched animal in
a view not shown here, which one-to-one assignment correctly leaves over (the app
badges such leftovers **?**; that badge is a real state and the panel still renders
it when it occurs in a shown view). Frame 198 was chosen from a scan of the
session's 300 frames for the cleanest third animal in both shown views with both
figure views complete and fully assigned. Illustration; quantified in Figs 3 and 7. **d**, The same frame
triangulated. Left, cam 0 mid's video with the identity overlays; middle, LUC3D's
3D viewport placed at that camera's own pose and field of view (its "Show Camera
View"), rendered at the camera's aspect ratio and cropped to the identical
normalised region, so the two can be compared directly; right, the rig, all eight
calibrated cameras plus the three reconstructed animals in their identity colours.
The rig tile carries geometry only — the app's camera name labels are switched off,
because they are screen-space bitmaps at a fixed pixel size and pile up at the
magnification this tile needs. Two *pairs* of cameras project within ~12 px of each
other in the 799 × 450 render (`Camera0_mid`/`Camera4_topR`, 10.7 px;
`Camera2_topC`/`Camera7_sideR`, 13.7 px; `fig1.json threeD.rigFraming.camScreen`), so
fewer than eight frustums are separable by eye at this viewing angle; every camera's
projected position is deposited for a composer that wants to typeset the names.
All 3 animals were reconstructed, with all 45 of 45 3D
keypoints (15 nodes × 3 animals) filled. **e**, Capability comparison; every
non-LUC3D cell was checked against that tool's published documentation on
2026-08-05 (the table's own `CHECK_DATE`; see qualifications below).

**Panel e qualifications.** *SLEAP*: multi-camera 3D exists outside the GUI, in
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
  — the view shown in **c** and **d** — looks almost straight down. Rather than
  print a classification the figure cannot derive from `figs/out/` (the calibration
  lives in the gitignored `figs/session/`), the artwork says only "rig" and the
  caption says "eight calibrated cameras". If a reviewer asks for the split, quote
  the 4 + 4 from the calibration, not the names.
* **21.** `distinctTrackNames` = 21 is the 25 per-camera detections collapsed by
  name. Three names are reused by more than one camera (`track_89` in cams 0 and
  5, `track_93` in cams 5, 6 and 7, `track_127` in cams 1 and 4). Two of those
  three coincidences happen to land on the same animal; `track_127` does not — it
  is identity 2 in cam 1 and identity 1 in cam 4. Either way the numbering carries
  no cross-view meaning, and quoting the collapsed 21 alone would understate the
  association problem by exactly the collisions that make it worse. Quote **25
  detections carrying 21 distinct names**, as the caption does.
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
frame to 32 — because only 5.5% of reprojections fall outside a 10 px tolerance and
need touching at all.**
(a) The protocol in the app, in four steps: two anchor views labelled (cam 1 topB,
cam 6 sideL); the 3D solved from those two alone (the other six views set to weight 0
in the app's Camera Views panel, so they cannot contribute); the resulting reprojection
drawn into every remaining view (cam 0 mid and cam 2 topC shown, neither labelled); and
one view magnified beside that frame's measured per-view error split. **This protocol is
not novel and the figure does not claim it is**: JARVIS's AnnotationTool already
projects manual annotations from a subset of cameras onto the remaining ones and
surfaces a reprojection error bar, and Label3D is the direct predecessor for
reprojection-aided multi-camera 3D labelling. Both are in the Fig 1e table and both are
cited here. What is new is the browser implementation and the quantification in b–d.
(b) Manual keypoint placements per animal per frame against rig size C, for two accept
tolerances (τ = 10 px solid, τ = 5 px dashed) against traditional labelling. τ is the
tolerance at which a labeller accepts a reprojection untouched and p the measured
fraction that miss it. **Only one rig size was measured, and the panel says so rather
than shading a region.** All 56 Mouse-Dyad-10M sessions are five-camera rigs, so p is a single
number measured at C = 5 from a two-anchor solve with three held-out views — the one
filled marker on the whole panel. Every other point on both curves, at C < 5 exactly as much
as at C > 5, is the model `aided = 2N + (C−2)·N·p` against `traditional = C·N` with
N = 15. The 2.3× is annotated at that one measured C and nowhere else.
(c) 3D error against the number of cameras in the solve, all five included: the 3D
distance between the k-view DLT solve and the proofread reference, k = 2 to 5. Medians
4.74 / 2.89 / 1.91 / 1.19 mm — big gains early, diminishing later, ending at the
all-view solve. Boxes are the **across-session** distribution of the 50 session medians
— median, IQR, whiskers to 1.5× IQR — and every session is also drawn as a dot, so a dot
past a whisker is a session, not a separate flier encoding. (Through 2026-08-17 the box's
hinges were instead the across-session median of each session's own keypoint p25/p75,
which is a typical session's **within**-session spread: 2.57–8.68 mm at k = 2 against the
session medians' 3.65–6.95. Both families are in `data/fig2/fig2c_error_by_cameras.csv`,
`sess_*` and `agg_*`.) These are comparison values against a reference that carries its own error
(median reprojection 2.41 px), not absolute 3D accuracy; the spacing is what the panel
supports.
(d) Median 3D error of a two-anchor solve against the angle that anchor pair subtends
at the animal, one marker per camera pair; the dashed curve is the depth-uncertainty
law k/sin θ with k = 1.52 mm and the band is ±25%, and the dotted rule is the
all-five-view comparison floor (1.19 mm).
n = 56 Mouse-Dyad-10M sessions, 286,200,174 keypoints (every frame of 10,084,734), 5
cameras, 2 mice, 15 nodes; panels b and d use all 56 sessions, and panel c is
measured over the 50-session subset `fig4_by_views.json` covers.

## Second finding, for panel d

**Which two views are chosen matters more than that only two were chosen: on this rig
the widest available pair gives 2.7 mm of median 3D error and the narrowest 12.6 mm, a
4.7-fold difference that costs nothing at annotation time.** The ordering is not
marginal — the widest pair (cameras 0 + 1, 31.5°) is the most accurate pair in 56 of 56
sessions and the narrowest (cameras 1 + 2, 13.5°) the least accurate in 56 of 56.
Baseline angle is the **dominant, not the sole** factor: fitting err = k/sin θ (k =
1.52 mm, estimated robustly as the median of err·sin θ) puts 8 of the 10 pairs within
±25%, and the two exceptions both pair camera 2 — the most distant camera, 1.32 m from
the animals against 0.98–1.07 m for the other four — with its two angular neighbours,
where a narrow angle and a coarse mm-per-pixel compound. This concerns only which two
views you *label*; the final reconstruction should still use every available view
(1.19 mm).

## Methods

* Every frame enters (stride 1): 10,084,734 frames, 286,200,174 keypoints, over all 56
  Mouse-Dyad-10M sessions (`out/fig2.json`). Identity matched per view against the reference
  reprojection.
* τ = 20 px is the app's own `reprojSigma` default (`ui/settings.js`); **panel b draws
  τ = 10 px and τ = 5 px only**, so the headline ratio is the τ = 10 px one. Placement
  model `traditional = C·N`, `aided = 2N + (C−2)·N·p`, with N = 15 the per-animal
  skeleton.
* Measured p (implied by the deposited placement counts,
  `data/fig2/fig2b_placements_vs_rig.csv`): 39.3% at τ = 5 px, **5.5%** at τ = 10 px.
  At the measured rig size C = 5 that is 75 → 32.5 placements (**2.3×**, the value
  annotated on panel b) at τ = 10 px and 75 → 47.7 (1.57×) at τ = 5 px. The C = 8 value
  at τ = 10 px, **3.44×** (120 → 34.9), is an **extrapolation of the model past the one
  measured rig size**, not a measurement; the panel marks this by carrying exactly one
  filled marker in total, not by shading a region.
* Panel c reads `out/fig4_by_views.json` (`err3d_mm_across_sessions`,
  `per_session[].by_k`, 50 sessions): 170,134,120 keypoint solves at k = 2 and 3,
  85,067,060 at k = 4, 17,013,412 at k = 5
  (`data/fig2/fig2c_error_by_cameras.csv`). The held-out px form of the same
  measurement — score the k-view solve in a camera outside the solve — is deposited as
  `data/fig2/fig2c_heldout_by_cameras.csv` (medians 4.32 / 3.66 / 3.34 px at
  k = 2 / 3 / 4; it exists only for k ≤ 4, because one camera must stay out to judge)
  and renders under `--heldout`; it is the out-of-sample form Fig 4b builds on.
* Panel d: 2,862,001,740 two-anchor solve keypoints (10 pairs × 286,200,174, every
  frame of all 56 sessions). Both coordinates of each marker are medians across
  sessions — the baseline angle moves a little between sessions because its vertex is
  that session's own mean proofread 3D point. Camera centres come from the calibration
  extrinsics as C = −Rᵀt; the vertex is the mean proofread 3D point, i.e. the real
  animals.
* **What "3D error" means here, since it is neither of the two things a reader will
  assume.** It is *not* a reprojection error (it is millimetres, not pixels), and it is
  *not* our k-view solve against our own 5-view solve — if it were, the k = 5 point would
  be identically zero by construction. It is the 3D Euclidean distance between (i) the
  candidate, a DLT triangulation from k chosen views, and (ii) the **corpus's proofread
  3D**, which comes from a different pipeline and is mapped into our calibration frame by
  a RANSAC similarity fit (scale, rotation, translation), then converted to millimetres
  through the recovered metric scale. Median 3D error by number of anchor views labelled:
  2 → 4.74 mm, 3 → 2.89, 4 → 1.91, 5 → 1.19.
* **Why a coordinate-frame fit is needed at all, and why the ~1.2 mm floor is NOT an
  artefact of it.** The proofread 3D ships as `*_points3d_translated_rotated_metric.h5`:
  it was deliberately translated, rotated and converted to **metres**, while the
  calibration frame is in millimetres (the recovered scale is ~995 or ~1013 depending on
  which of the corpus's two calibrations a session uses). A RANSAC similarity fit undoes
  that post-processing, and it fits well — 97–98% inliers in every session.
  **Its median residual (1.21 mm) and the k = 5 error (1.19 mm pooled, 1.21 mm as a
  median of session medians) are the same measurement
  on different frame subsets** — both are "our all-camera DLT of the per-camera 2D against
  their proofread 3D", one fit on a ~4,000-frame sample and one evaluated on the
  analysis frames. Their agreement is therefore near-tautological and must not be
  read as "alignment error dominates".
* **What the ~1.2 mm floor actually is, and what it bounds.** It is the genuine median disagreement
  between our five-view reconstruction and the corpus's proofread 3D, absorbing three
  things at once: the 2D detector's error, whatever human correction the proofread pass
  applied in 3D, and any residual frame mismatch. It is a floor on what *this comparison*
  can resolve, so the absolute values cannot be read as absolute 3D accuracy — the
  reference has its own error (median reprojection 2.41 px, higher than either candidate
  solver's, which is the same reason Fig 4 makes no 3D comparison between solvers). The
  *spacing* between the four values is what the panel supports: two anchors cost ~3.5 mm
  relative to five. "Five views are accurate to 1.2 mm" is not supported.
* Panel a is one frame of an 8-camera HardFight recording; panels b, c and d are the
  5-camera Mouse-Dyad-10M corpus, which is the only one with a proofread 3D reconstruction to
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
  residual.** Across-session median 1.21 mm against a median RANSAC–Procrustes residual of
  1.21 mm, and **54 of 56 sessions agree within 5%**; two do not (22.6% and 25.6%,
  relative to that session's alignment residual). The earlier claim of "within
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

**Greedy per-camera Hungarian assignment chooses the same grouping as exhaustive
hypothesis enumeration on 4,591,055 of the 4,591,864 frames both could be scored on
(99.982%, 92 sessions), and against proofread ground truth the shipped fresh-anchor
grouping misgroups FEWER frames than the exhaustive search (940 against 1,453 of
4,591,725 scored), at about a million-fold lower cost in the configuration where
enumeration becomes intractable.**
(**a**) The two strategies, drawn as the two shapes of the search rather than as their
answers. Exhaustive hypothesis testing (Maree et al. 2024) enumerates every grouping of
detections into identities — `A!` per view, `(A!)^C` per frame for `A` animals and `C`
cameras — triangulates and reprojects each, and keeps the one with the lowest
reprojection error. LUC3D solves one Hungarian assignment per camera, committing that
camera's assignment to the running set of 3D targets before the next camera is solved,
at O(C·A³) — a chain of C solves, not (A!)^C hypotheses. The cost the Hungarian solver
minimises is stated in full in Methods: a 2D term on the distance between the detection
and the target's reprojection into that view, decayed by the target's age, and a 3D
term on the perpendicular distance from the target to the detection's back-projected
ray. (The panel that printed that cost verbatim was cut from the layout 2026-08-14;
`panels/fig3_02_cost_terms.py` still renders it under a supplementary slug.)
(**b**) Hypotheses per frame for the exhaustive method, one curve per rig size, exact
arithmetic; the dotted rule is the harness's own 10⁶ hypotheses-per-frame cap. This axis
carries **only** the exhaustive count: the greedy solve enumerates no hypotheses at all,
so its cost is measured in **e** (the teal series), not drawn as a second curve here.
(**c**) **Grouping quality head to head against proofread ground truth, on the identical
detections, for every frame the exhaustive method could be run at all** (4,591,725
GT-scored clean frames across the four tractable configurations; a frame is clean when
every camera holds exactly A detections). Frames whose grouping differs from the
ground-truth partition (label-invariant comparison over IoU-0.5-matched detections), as
a rate per 10,000 clean frames, per configuration; each configuration's clean-frame
count is under its tick (4.3M, 238k, 10k, 19k). Two series: exhaustive (filled) and
LUC3D's greedy grouping at the **fresh-anchor** operating point (hollow; per-view
detections expire from the 3D anchor after 20 frames, synchronous per-frame update, 3D
distance normaliser 25 mm — the shipped configuration; see Methods). Pooled, the fresh
anchor misgroups **940** frames (2.05 per 10,000) against exhaustive's **1,453** (3.16
per 10,000); per configuration 1.32 / 14.5 / 12.5 / 4.7 against 1.29 / 30.1 / 15.4 /
85.2 at 2×5 / 2×6 / 3×5 / 4×3. On the **672** frames where the two choose different
groupings, ground truth sides with the greedy grouping on **592** and with exhaustive
on **79** (one frame matches both): on most disagreements the exhaustive optimum is an
in-sample victory over the reprojection objective, and the held-out ground truth sides
with the cheaper grouping. The **previous default** configuration misgroups 1,077
frames (2.35 per 10,000; 809 disagreements with exhaustive, ground truth siding
592/216); it is deposited and its render is kept under a separate slug (`--as-shipped`).
(**d**) An ablation **of LUC3D against itself**, over all 50 Mouse-Dyad-10M sessions at full
length, for the fresh-anchor configuration of **c**: within-view ID switches per
100,000 camera-frames (top, log axis; denominator 45,021,960 camera-frames) and
cross-view IDF1 (bottom) against r = corr3d/corr2d (log axis). Only the ratio matters
(verified on the earlier 8-session grid, where all 24 (corr2d, corr3d) combinations
collapsed exactly onto r), so each r is sampled once at corr2d = 1. **The sweep shows
the 3D term must be switched on and where each metric stops improving; it does not
select 6.** With the term off (r = 0) the arm gives 632 switches per 100,000 at IDF1
0.599; at the marked app default r = 6 it holds 413 switches (0.92 per 100,000) at
IDF1 0.8613, where the previous default configuration holds 2,071 switches at 0.7493
at the same r (deposited; drawn under a separate slug). The flat salmon rule is exhaustive
enumeration — a **frame-matched reference level, not a third arm of the sweep**, constant
in r because it does not use the cost function. It is scored over **exactly the frames
exhaustive can enter**: the 21,622,345 camera-frames, 48% of the exposure, where every
camera holds exactly two clean detections. On those same frames the greedy arm
(`fig3_bench.mjs` at default thresholds, not the swept fresh-anchor configuration) scores
**0.791** IDF1 and **8.0** switches per 100,000 against exhaustive's **0.628** and
**81.0**, and exhaustive is higher in 10 of the 50 sessions; that comparison is the
like-for-like one, and both arms are deposited in
`data/fig3/fig3d_frame_matched_rules.csv` rather than drawn as a second rule.

**The IDF1 rule used to read 0.400, and that number was a coverage artefact.** Until
2026-08-18 both arms were scored over the whole session (`fig3_headtohead.py`), so
exhaustive was charged an identity miss for every frame it structurally cannot enter
while greedy was scored on all of them — and across the 50 sessions that IDF1 correlates
0.86 with per-session coverage. The switch rule did not move at all (17,516 switches,
81.00879 → 81.0088 per 100,000), because a switch count is only ever tallied where the
method emits output; that invariance is asserted at build time as the check that the two
scorings are the same measurement. What frame-matching does **not** remove: exhaustive is
purely per-frame, so its identities exist only through the nearest-3D-centroid threading
described in Methods, and on the matched frames its IDP, IDR and IDF1 are equal (a 1:1
detection match to ground truth), which means the residual 0.628-vs-0.791 gap is
temporal bookkeeping rather than association — the two methods choose the **same
partition on 99.996%** of these frames.
(**e**) Measured wall-clock time per frame for both methods on identical detections, over
the four configurations that could be attempted, on a log axis from 1 ms to 1 day; the
panel carries the partition-agreement rate and both frame counts. The 4-animal,
6-camera point ((4!)⁶ = 1.9 × 10⁸ hypotheses per frame, 191× above the harness's 10⁶
cap, **zero frames computed**) is drawn as an **open marker — this figure's convention
for "not measured"** — at a **lower bound** of ~1,981 s (0.55 h) per frame, with a bar
running **up** from it to ~75,588 s (21 h). The marker, and every claim made from it,
is the floor: it grants the search the A!-fold label symmetry the published (A!)^C
enumeration does not exploit ((4!)⁵ = 7,962,624 distinct hypotheses) *and* uses the
cheapest measured per-hypothesis rate (249 µs, from 2×6). The bar's upper cap is the
as-published count at the 396 µs rate measured at the largest configuration that ran
(4×3).

*Methods.* Cost is summed over nodes k with per-node weights wₖ (wₖ = 0 drops a node
from the association entirely) and negated, so the Hungarian solver minimises it. Both
thresholds are soft — exceeding one drives its term negative rather than gating the pair.
The shipped configuration is the **fresh anchor**: corr2d = 1.0, corr3d = 6.0 (r = 6),
per-view detections expiring from the 3D anchor after 20 frames, synchronous per-frame
update, 3D distance normaliser 25 mm. The **previous default** (no per-view expiry,
sequential update, 50 mm) is retained in every deposit and its renders are recoverable
(`--as-shipped` for panel c, the separate shipped slug for panel d). IDF1 and raw
ID-switch counts are computed with motmetrics; every method receives the identical
identity-stripped detection pool, so the comparison isolates association from detector
quality. **The exhaustive method is our reimplementation of the published per-frame
procedure, not the authors' code.** It is undefined on any frame where a camera does
not detect exactly `A` animals, because `A!` per view is then ill-posed: of
**9,678,503** frames considered across the 92 sessions, **4,591,864 (47.4%)** were
eligible and **5,086,639 (52.6%)** were skipped and counted, not silently dropped
(per-configuration eligibility 48.0 / 43.6 / 14.4 / 34.4%). Every eligible frame was
computed; the per-session caps an earlier pass placed on the 3×5 and 4×3 configurations
are gone. The skipped frames are the occluded ones, i.e. exactly the frames association
finds hardest, so exhaustive never faced them. The eligible frames are also not evenly
spread across the difficulty range the panel spans: **4,324,469 of 4,591,864 (94.2%)**
come from the single easiest configuration (2 animals × 5 cameras, 32 hypotheses), and
only 10,419 frames (0.23%) test 3 animals. So the pooled agreement is a statement about
an almost-entirely-two-animal, occlusion-free sample; per configuration the agreement
is 99.996 / 99.814 / 99.760 / **99.038**% at 2×5 / 2×6 / 3×5 / 4×3, and the panel
prints the frame counts.
Panel **e**'s extrapolated point is deliberately **not** priced at the published count ×
the closest-matching rate. That product — 1.9 × 10⁸ hypotheses at the 396 µs rate
measured at 4×3 ≈ **75,588 s ≈ 21 h per frame** — is what the bar's upper cap marks,
and on an axis whose top tick is 1 day it would read as the headline "a day per frame".
It is an overstatement, for a reason intrinsic to the (A!)^C count: applying the *same*
permutation to every camera relabels the groups but leaves the partition and its cost
identical, so each distinct hypothesis is enumerated A! times over. Fixing one camera's
labels leaves **(A!)^(C-1) = 24⁵ = 7,962,624** distinct hypotheses, 24× fewer. The
plotted marker therefore takes that reduced count at the **cheapest** measured rate
(249 µs, from 2×6): **~1,981 s ≈ 0.55 h per frame**, i.e. one second of 50 fps video
costs **≥ 1 day**. That floor is generous to exhaustive, because 249 µs was measured at
A = 2 and per-hypothesis cost grows with A — each hypothesis triangulates A groups and
reprojects into C cameras. Even at the floor the gap to LUC3D is **8.1 × 10⁵**
(1,980.9 s against 2.44 ms), the ~10⁶× callout on the artwork. Note the harness's
**10⁶ cap is a cap, not a count** — 4×6 exceeds it by 191×, which is why zero frames
ran. A memoized implementation that cached per-group triangulations across hypotheses
could beat the per-hypothesis cost model outright, but that is a different algorithm
from the published per-frame procedure this panel reimplements and prices. Panel
**e**'s LUC3D times (1.1–2.4 ms per frame) come from the `fig3_runtime.json measured`
table, matched to each configuration by (animals, cameras) **and corpus** rather than
averaged — the (2, 5) cell was measured twice on two corpora and the exhaustive 2×5 run
is Mouse-Dyad-10M, so the Mouse-Dyad-10M LUC3D measurement is the one set beside it.

**The intractability claim does not rest on the measured per-hypothesis rate.** Our
exhaustive is a single-threaded JavaScript reimplementation, so an optimised C++ or GPU
implementation could plausibly be two orders of magnitude faster. That would still
leave **minutes per frame** at 4 animals × 6 cameras, so the statement that survives
any implementation is that the configuration is intractable — not that any one µs
figure is the true per-hypothesis cost. The measured per-hypothesis rates run 249–396
µs across the four computed configurations, and the floor uses the cheapest while the
cap uses the one measured at the largest configuration that ran. Panel **e**'s
configurations stop at C = 6 because the shared 8-camera detection pool does not
exist — side and sideL are only available as raw per-session `.slp` in a
non-overlapping session subset, and using them would mean scoring on a different
detection pool from every other point.

*Supplementary Note.* **The agreement rate on panel e is an agreement result, not a
win.** Greedy and exhaustive choose the same partition of detections on 99.982% of
computed frames; the claim is that a cheap method loses nothing, not that it is more
accurate. (Panel **c** is the arm of the comparison where a difference does appear, and
it favours greedy — held-out ground truth sides with the cheaper grouping on 592 of the
672 disagreement frames.) The exhaustive method is purely per-frame with no temporal
mechanism, so to make IDF1 computable for it at all our implementation threads identity
across frames by nearest-3D-centroid matching to the previous computed frame; that
threading is not part of the association decision, which is why panel d draws
exhaustive's IDF1 (0.628 frame-matched, over the same 21,622,345 clean camera-frames as
the greedy arm's 0.791) and switch rate (81.0 per 100,000 against 8.0) as flat reference
rules rather than as a third arm, and why the
partition agreement is the number the figure reports.

**The response in panel d is flat in the ratio, not in the 3D weight, and the sweep
does not single out r = 6.** The axis is one-dimensional because only the ratio
matters: on the earlier 8-session grid all 24 (corr2d, corr3d) cells collapsed exactly
onto r, verified rather than assumed, so the 50-session sweep samples each r once at
corr2d = 1. What the sweep supports is that **the 3D term must be on**: with it
switched off entirely (r = 0) the fresh-anchor arm gives its worst IDF1, 0.599, and
632 switches per 100,000 camera-frames; by r = 0.25 the rate has already fallen to
4.66 per 100,000. Beyond that both metrics sit on a plateau that extends to the end of
the swept range (r = 24): the shipped r = 6 holds 413 switches at IDF1 0.8613, and the
sweep's minimum, 371 switches at r = 12, buys no IDF1 over it (0.8614 against 0.8613).
The shipped r = 6 is marked because it is the default, not because the sweep picked
it; nothing here recommends 6 over any other r ≥ 2, and the caption must not say the
sweep chose it.

`pose/cross-view-tracker.js` is a port of Maree's *temporal* CrossViewTracker, a different
component from the annotation-time association compared here. Credit for both the
exhaustive method and for naming the greedy alternative as future work belongs to
Maree et al. 2024.

---

## Figure 4 — Triangulation

> Every number below is printed by `python3 figs/fig4.py` as `[caption]` lines, read
> straight from `figs/out/fig4.json`, so the caption can be checked against that output
> rather than trusted. Two panels read their own deposits: (**b**) from
> `figs/out/fig4_by_views.json` (`figs/fig4_by_views.mjs`, both LUC3D solvers by view
> count — it used to read `fig2.json`), and the Anipose arms of (**d**, **e**) from
> `figs/out/fig4_anipose.json` (`figs/fig4_anipose.py`).

**The accuracy of a triangulated keypoint is set by how many views contribute and by
whether a badly-fitting view is rejected — 4.32 → 3.34 px in a camera the solve never
saw as views go from two to four, and a median 7.2 mm displacement from dropping one
view that disagrees by ≥ 10 px — not by the choice of solver. Across four solvers, two
ours and two Anipose's, the whole spread on a held-out camera is 3.11–3.34 px; the
lowest is Anipose's, and neither library's non-linear refinement earns its cost out of
sample.**

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
(**b**) **Reference-free.** Solve from *k* of the five cameras (every C-choose-*k*
subset), project into each camera **outside** the subset, and score against that
camera's raw detection in its native, still-distorted pixels. Both LUC3D solvers;
median over 50 sessions, one value per session per solver. **Error bars are the
distribution-free 95% CI of that median** — the 18th and 33rd of the 50 sorted
sessions, exact binomial coverage 96.7%, so no bootstrap and no seed. They are the
precision of the plotted point, not the spread of the sessions: the between-session
IQR is 3.38–4.45 px for the DLT at k = 2 against a CI of 4.11–4.40, and it is
deposited (`*_p25`/`*_p75` in `fig4b_accuracy_vs_cameras.csv`) rather than drawn,
because as a ribbon it was a redraw of Fig 2c's boxes. **The solver comparison is
paired and the bars understate it**: the two solvers run on the same 50 sessions, so
the test of the crossing is the per-session difference — refined minus DLT +0.111 px
at k = 2 (DLT lower in 50/50 sessions), −0.069 at k = 3 (refined lower in 33/50) and
−0.098 at k = 4 (34/50) — not whether two unpaired intervals overlap, and they do
overlap at k = 3 and 4. DLT **4.32 / 3.65 / 3.34 px** and refinement
**4.43 / 3.53 / 3.15** for 2/3/4 cameras — a **1.29×** and **1.41×** improvement.
No reference 3D enters this panel, and **neither solver optimises this metric**: the
refinement minimises reprojection error in the views it *was* given, never the
held-out one. So the ranking here is contingent, and it flips — the refinement is
**worse** than the DLT at two views (4.43 vs 4.32) and better at three and four
(3.53 vs 3.65, 3.15 vs 3.34). A sign flip is the one thing a rigged metric cannot
produce.

***k* stops at 4 because a five-camera rig has no fifth camera to hold out**, not by
choice. n = 31.9 M / 21.3 M / 5.3 M held-out measurements at k = 2/3/4.

**This panel used to plot 3D distance to the proofread reference, and it was changed
because that axis cannot compare two solvers.** `figs/fig4_move_geometry.mjs` measures
why, per keypoint, with D = DLT, R = refined, G = reference:

| | \|D−G\| | \|R−D\| (the move) | \|R−G\| measured | if ⟂: √(\|D−G\|²+\|R−D\|²) | if straight away |
|---|---|---|---|---|---|
| k = 2 | 2.697 mm | 0.559 | **2.895** | **2.917** | 3.256 |
| k = 5 | 1.214 | 1.249 | **1.852** | 2.116 | 2.463 |

The refinement moves about as far as the reference sits from the DLT, in a direction
essentially **uncorrelated** with the direction to the reference (median cos 0.004 at
k = 2, 0.135 at k = 5; means 0.002 and 0.066). Adding a displacement orthogonal to an
existing error always increases the distance — measured 2.895 mm against a
perpendicular prediction of 2.917 — so that axis reported "the refinement moved" and
read it out as "the refinement is worse", whichever way it moved. Arithmetic, not
accuracy. **It equally rules out the opposite reading**, that the refinement trades 3D
accuracy for 2D fit (real when calibration is biased): that would move systematically
*away*, giving a clearly negative cosine and \|R−G\| → 2.463 mm at k = 5. The measured
cosine is slightly **positive**. The refinement is not degrading the 3D; the reference
cannot see what it did.

The mm arm is still measured and deposited in `fig4_by_views.json`
(`err3d_mm_across_sessions`) and is quotable **for one solver against itself across
k**, where the bias is ~constant and cancels: DLT **4.73 → 1.21 mm** from two views to
five, a **3.9×** span, reaching the *k* = 5 point this panel cannot. It is not
plotted, and it must not be used to rank solvers.

Panel b reads `figs/out/fig4_by_views.json` (`figs/fig4_by_views.mjs`, the real branch
solvers, stride 240 = every 4th keypoint of the stride-60 export, 1,063,427 keypoints,
55.3 M solves). Its mm arm reproduces `fig2.json`'s `err3d_mm_by_anchor_count` to
**0.1–0.7% at every k**, which is what licenses calling this the same measurement Fig 2
made with a second arm added. Its px arm runs **5–10% above** `fig4.json`'s
`heldout_by_views` by construction — that one pools over keypoints and holds out one
fixed camera, this one is a median of session medians over every C-choose-*k* subset.
Same story, different estimator; **do not mix the two sets of numbers**. And *not*
`fig2.json`'s `by_anchor_count` px arm, which despite the name scores against the
reprojected reference (`gtk`) rather than the raw detection.
(**c**) Reprojection error in the **kept** views, all five in the solve against the
single worst-fitting view dropped and the point re-solved from the rest, per session:
**one grey line per session**, 50 of them, and the teal pair is the across-session mean
with a **t-based 95% CI** (n = 50, so mean ± t(49) × SEM). 2.056 [1.984, 2.129] px falls
to 1.711 [1.651, 1.772]. The bars are the CI of the mean and not ±1 s.d., because the
spread is already the 50 lines and a bar repeating it would be a second encoding of
marks already on the panel. **The paired change is the stronger statement and is on the
artwork**: −0.345 px, 95% CI [−0.359, −0.332], **lower in 50 of 50 sessions** — an
interval seven times tighter than either mean's, because the between-session variation
(s.d. 0.25 px) cancels in the difference. The y axis starts at 1.0, below the lowest
session (1.27), so that a 0.14 px interval is legible; no line is clipped. No reference
3D enters this measurement. (Through 2026-08-15 this panel was a three-stratum box
chart binned by worst-view disagreement — medians 1.07 / 1.76 / 7.18 mm at n =
1,167,554 / 3,019,181 / 66,901; that form was cut on request and its numbers remain in
`fig4.json`'s `robust` block.)
(**d**, **e**) **Four solvers, paired by algorithm class**, so that each comparison is
between two things that do the same amount of work:

| | linear (closed form) | non-linear (iterative, cameras fixed) |
|---|---|---|
| Anipose | `CameraGroup.triangulate` | `optim_points` |
| LUC3D | our DLT | our refinement |

Reading *across* a pair is the comparison; reading *down* a column is what refining
costs inside one library. An earlier draft drew only Anipose's linear solve, which put
their closed-form SVD next to our iterative one and invited the reading "our refinement
is 1.6× slower than Anipose" — a category error, and the reason both panels now carry
all four.

(**d**) Median reprojection error per session, one box-and-whisker per solver over the
50 sessions: median, IQR, whiskers to 1.5× IQR, and the session — not the pooled
keypoint — as the unit, so the median is the median of the 50 session medians. All four
columns are the same 4,253,636 keypoints. **Open boxes** mark the `optim` columns,
filled the linear ones. The panel is scored **in the cameras the solve used** and is
labelled **(refined enforced)**, because our refinement minimises the reported metric
and a backtracking guard vetoes any step that raises it, so "refined lowest" here
cannot come out otherwise. The out-of-sample arm — scored in a camera no solve saw,
where nothing is enforced — is deposited rather than drawn, and there **Anipose is
lower in both pairs, 50/50 and 49/50** (3.11 / 3.34 linear, 3.12 / 3.14 non-linear).
Which session went where is in `data/fig4/fig4d_per_session.csv`; the paired win counts
are the summary of it.
(**e**) Solve time per keypoint. All four bars are the **solve alone** — undistortion is
excluded from every one, because `CameraGroup.triangulate` undistorts inside the call
and LUC3D undistorts outside it, and charging only one of them would be an artefact of
where each library draws a function boundary (excluded: 0.45 µs Anipose, 1.17 LUC3D).
LUC3D measured in-process (single-threaded Node 26, `performance.now()` around each
call, 4,253,636 keypoints); Anipose with `perf_counter`, best of 3 over 88,343. **We are
4.4× faster on the linear pair (6.3 vs 28.1 µs) and 2.7× on the non-linear one (43.8 vs
122.1).** The `optim` bar carries a whisker because it is **not a per-keypoint
constant**: `optim_points` is one global `scipy.least_squares` per session, so its cost
per keypoint falls as fixed costs amortise — 393.7 µs/keypoint at 1,000 frames, then
114.9 and 122.1 at 2,000 and 4,000. The bar is the largest run and the whisker spans the
session-scale sizes only.

**Anipose here is aniposelib 0.7.2** — the OpenCV/NumPy pipeline (`cv2.undistortPoints`,
then a per-point `numpy.linalg.svd` DLT), the last release before the JAX rewrite and
the newest one `anipose` itself accepts (`Requires-Dist: aniposelib >=0.7.0`). It is
**not** 0.8.0, whose `jax.vmap` rewrite is a different program with different
performance; `figs/fig4_anipose.py` refuses to run against a JAX build. On the linear
path both libraries solve one keypoint at a time, so (e)'s first pair compares like with
like rather than a batched library against a per-call one.

**Which Anipose configuration each column is.** `anipose triangulate` reads two flags,
both `False` by default (verified in `anipose/anipose.py`): `optim: false, ransac: false`
→ `CameraGroup.triangulate` (the *linear* columns); `optim: true` → `optim_points` (the
*optim* columns); `ransac: true` → `triangulate_ransac`, which costs **2,339
µs/keypoint** — 83× the default path and 53× our refinement — and is reported here
rather than drawn, because a bar that size flattens every other bar in the panel.
Naming the flag matters: "Anipose" spans two orders of magnitude in cost depending on it.

**The optim columns have temporal smoothing disabled, and that is the charitable
choice, not a convenient one.** aniposelib's `optim_points` defaults add a smoothing
term across consecutive frames (`scale_smooth=4`). `fig4_input` is sampled at stride 60
and then filtered to keypoints complete in all five views, so its "consecutive" entries
are 60+ frames apart: the smoothing term would be penalising real motion as noise, and
the column would report *our sampling* rather than Anipose's method. With it left on,
Anipose's optimiser is worse than **its own** linear solve in 50/50 sessions (2.270 /
3.158 px against 2.264 / 3.111). Off, what remains is soft-L1 reprojection error with
the cameras held fixed — exactly what our refinement is. `fig4_anipose.py` measures both
and deposits both (`fig4e_anipose_optim_accuracy.csv`); the panels draw the fair one.

## Findings

* **View count dominates, for both solvers, reference-free.** Held-out error 4.32 →
  3.34 px for the DLT and 4.43 → 3.15 px for the refinement, two to four cameras
  (**1.29×** and **1.41×**, panel b). The reference-based mm arm reaches the fifth
  camera and is quotable for a solver against itself: DLT **4.73 → 1.21 mm**, a
  **3.9×** span. The px effect looks smaller than the mm effect for a real reason, not
  a measurement defect: held-out reprojection error has a floor set by the detector's
  own noise in the held-out view, which no solve can remove. The px effect is smaller than the mm effect because held-out
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
* **Anipose is lower than the LUC3D solver it is paired with, in both pairs, out of
  sample.** On the held-out camera — the only group in (d) where nothing is enforced —
  Anipose's linear solve beats our DLT in **50/50** sessions (3.111 vs 3.335 px) and
  its `optim_points` beats our refinement in **49/50** (3.115 vs 3.144). In the cameras
  the solve used, Anipose's linear is below our DLT in **50/50** (2.264 vs 2.349); only
  our refinement is lower there, and that group is enforced for it. So our refinement
  buys — at 6.9× the cost of our DLT — an out-of-sample result Anipose's *closed-form*
  solve already has, for 28 µs and no iteration.
* **Anipose's own non-linear optimiser buys it almost nothing, which is the more
  interesting half of that result.** `optim_points` improves on Anipose's linear solve
  by **0.008 px** in sample (2.264 → 2.256, in 50/50 sessions) and is **not** an
  improvement out of sample at all (3.111 → 3.115; better in only **13 of 50**), for
  4.4× the cost. This is not a failed run: the optimiser terminates on its own `ftol`
  after two iterations, and tightening `ftol` from aniposelib's `1e-3` to `1e-10`
  changes the result by nothing (1.6237 px either way). **It has converged — there was
  almost nothing to gain**, because a normalised DLT already sits essentially at the
  geometric optimum. Our refinement's 8% in-sample gain is therefore mostly it
  *recovering* the conditioning Anipose gets for free in closed form (see the next
  bullet), which is also why that gain does not survive out of sample.
* **The mechanism is the DLT's coordinate frame, and it is one line of algebra, not a
  better algorithm.** Both are the same linear DLT; they differ only in the space the
  rows are written in. LUC3D undistorts back to **pixels** and builds its system from
  K[R|t]; aniposelib undistorts to **normalised** coordinates and builds its system
  from [R|t] alone. That is Hartley's normalisation, the textbook conditioning fix for
  the DLT, and it is worth the whole gap. Reproduced directly: re-solving in the pixel
  frame recovers LUC3D's answers (median 3D separation 4.0 × 10⁻⁶ units) and re-solving
  in the normalised frame recovers Anipose's *exactly* (0.0), giving 1.6802 px against
  1.6697 px on the same 4,000 keypoints. **This is an actionable defect in LUC3D's
  `triangulatePointDLT`, not a reason to prefer another toolkit** — but nothing here
  has been changed in the app, and it should not be changed without the old-vs-new
  pinning test that every path calling that function deserves.
* **The metric is shared, and that was checked rather than assumed.** The Anipose arm
  scores reprojection error with `cv2.projectPoints`; the LUC3D arms with
  `pose-data.js`'s own `distortPoint`. The gaps in (d) are 0.07–0.22 px, so a 0.05 px
  disagreement between those two distortion implementations would have *been* the
  result. `figs/fig4_metric_check.mjs` dumps LUC3D's own DLT solutions and re-scores
  those same 3D points with cv2: median |cv2 − JS| = **4.2 × 10⁻¹⁴ px** over 20,000
  all-view keypoints and **8.7 × 10⁻¹⁴ px** over 100,000 held-out ones. Same metric to
  float64 rounding, so every difference in (d) is solver.
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
  fall all the way back). Panel d's
  left group therefore *cannot* come out any other way; the artwork prints
  "(refined enforced)" under it and quotes the Anipose-against-our-DLT count there
  instead, because that is the comparison in that group which could have gone either
  way. The group is shown only to give the size of the in-sample effect beside the
  out-of-sample one, which any of the three can lose — and ours does ("Anipose lowest in
  49/50" under the right group). **The distribution of the signed change in the app's
  *displayed* error, which an earlier draft drew as its own panel, is no longer on the
  artwork** — the figure has five panels, a–e, and e is solve time. The numbers that
  panel carried are kept in *Findings* below and printed by `fig4.py` as `[caption]`
  lines; do not cite a panel for them.
* **No 3D-accuracy RANKING of solvers is claimed, and none is available from this
  corpus — even though panel b now draws both solvers on a 3D axis.** That pairing is
  deliberate and it is not a ranking; read it with the ratio, which is on the artwork.
  The proofread reference's own native-space reprojection error is **2.406 px**, higher
  than DLT's 2.245 and the refinement's 2.056 — so the reference is not the minimiser of
  reprojection error on these detections. Distance to a reference that sits *further*
  from the data than either candidate rewards whichever candidate moved less, which is
  DLT by construction, and cannot arbitrate between two methods that differ precisely in
  which error they minimise. **What panel b contributes is the evidence that this is a
  metric artefact rather than an accuracy difference**: refined/DLT rises monotonically
  1.02× → 1.54× from two views to five, i.e. the deficit grows with the information the
  solver was given, which is what a distance-from-the-seed penalty does and what a real
  accuracy deficit does not. `fig4.json` carries the same effect stratified by
  worst-view disagreement as `by_worst_view` (clean 1.16→1.55, mid 1.21→1.94, outlier
  3.19→5.20 mm), still labelled a diagnostic and still not plotted, because a stratified
  version adds nothing panel b does not already show. Ranking these solvers in 3D needs
  a real ground truth — synthetic points or a calibration object, as the branch's own
  unit tests use. **This applies to the Anipose arm too**: it wins panel d's held-out
  group, which is a statement about reprojection error in an unseen camera, and that is
  the only thing panel d measures. It is not a claim that Anipose's 3D points are closer
  to the truth, and the corpus cannot support one.
* **Nothing here is a benchmark of Anipose the toolkit.** Two functions are measured —
  `CameraGroup.triangulate` and `optim_points` — on detections produced by our pipeline,
  with calibrations produced by our pipeline. Anipose's calibration, its 2D stage, its
  `filter_3d` pass and the bone-length constraints its optimiser is designed to be given
  are all absent, and several of them exist precisely to improve the 3D that
  triangulation returns. In particular `optim_points` is run here with **no constraints
  and no temporal smoothing**, which is the fair configuration for *this* corpus (see
  the caption) but is not how Anipose is meant to be used: the spatiotemporal
  regularisation is the Anipose paper's actual contribution, and this figure removes it.
  Read (d) and (e) as "the same triangulation problem, four solvers", not as a
  comparison between two toolkits — and do not read the small `optim` gain as evidence
  that Anipose's optimisation is not worth running on data it was designed for.
* **Panel b's 5-view point is a floor, and the 3.9× is a lower bound — but not for the
  reason an earlier draft gave.** (This bullet is about the mm arm, which panel b
  deposits but no longer plots — see (b).) At *k* = 5 the solve uses the same views the
  reference pipeline did, and the DLT median is 1.21 mm. That number is close to the RANSAC-Procrustes
  residual (1.20 mm), but **the two are the same measurement on different frame subsets**
  ("our all-camera DLT of the per-camera 2D against the proofread 3D"), so their agreement
  is near-tautological and is *not* evidence that frame-alignment error sets the floor —
  the fit is good, at 97–98% inliers. The floor is instead genuine disagreement with an
  external reference, absorbing the 2D detector's error and whatever human 3D correction
  the proofread pass applied. That still makes 3.9× a lower bound, because the denominator
  carries those errors and cannot go to zero, but the mechanism is reference error rather
  than a bad alignment. Panel **d**'s right-hand group is the reference-free counterpart
  — scored against a raw detection in a camera no solve saw — which is why both are
  shown. (The by-view-count breakdown that used to carry this letter was cut in the
  2026-08 review; its numbers are in *Findings*.)
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

All panels come from the **same 50 Mouse-Dyad-10M sessions** (5 cameras, 2 mice, 15 nodes,
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

## Figure 5 — A social 3D behaviour: the mutual upright display

*This section replaces the retired "Figure 5 — Proofreading" caption. The proofreading
panels (`fig5_02/03/04`) are still in the tree and still deposit their CSVs, but they
are no longer placed on the artwork; their caption text is in git history at
`0d0e349`. Every number below is either printed on the artwork or listed here. Panels
a–f come from `figs/out/fig5_upright.json` (`figs/fig5_upright.py`); panel g from
`figs/out/fig5_rear_coupling_2animal.json` (`figs/fig5_rear_coupling.py
--slap-animals 2`).*

---

**Two mice rear together, face to face, and hold it for about 0.7 s — and the display
is not symmetric: in each session one animal starts most of them, and pooled over all
539 displays the session's leader starts 80% of them. The initiator is up a median
0.37 s before the follower joins; both animals then rise, converge to a nose gap of
0.12 body lengths, and stay still (0.44× their own baseline speed, 94% of displays
below baseline). The coupling that makes this an event at all is in **g**: within two
body lengths, one animal's rear leaves the other **2.9× more likely than chance** to
be rearing at that moment and **4.1×** half a second later, against a flat 1.05× when
they are further apart and a flat circular-shift null. This is a 3D measurement
throughout: the configuration is defined by height above the floor and by a distance
between two animals, and no single camera view has either.**

(**a**) One display, five views. The 3D reconstruction (left) and the same instant as
each of the five cameras saw it. Every camera is 58–76° above the animals and the two
noses are 93–106 px apart in every view: **no camera has the vertical**, which is why
the height that defines the event exists only after triangulation. Real intrinsics,
distortion and extrinsics; the pose is aligned to the calibration frame by
RANSAC-Procrustes (98.3% inliers, 1.32 mm residual). Scale bar = 93 mm = one body
length.
(**b**) Time course around display onset, as the across-session median of per-session
median curves (band = p25–p75 across sessions). The two height curves are **ranks, not
individuals**: at each display the animal that peaked higher is drawn in teal and the
other in pink. The event is defined by both animals being reared and within two body
lengths — *not* by their noses being close, *not* by their heights matching, and *not*
by anything happening at a particular time — so the nose gap falling to **0.12 body
lengths (≈ 11 mm) exactly at onset** and the two heights rising and peaking together
are contingent facts, not restatements of the definition. Two animals that merely
happened to rear near each other would give two unrelated humps and a flat gap.
(**c**) How long the initiator is already up before the follower joins, as a fraction
of all 539 displays. Median **0.37 s** (p25–p75 0.16–0.89 s) — 56 frames at this rig's
150 fps, and one to two frames at 30 fps, which is why this analysis lives on Mouse-Dyad-10M.
The hatched bar is an **overflow bin**: 7.8% of displays have a lag longer than 2 s,
out to 19 s.
(**d**) Separation velocity between the two tail bases (left axis; negative = closing)
and each animal's speed relative to its own baseline (right axis), split by role. The
follower is moving fast before onset and both animals are still afterwards: they close,
hold, and withdraw.
(**e**) Speed during the display, as a multiple of that animal's own whole-session
median speed. Median **0.44×**, with **94% of displays below baseline** and a median
duration of **0.71 s**. Hatched bar = overflow (0.7% above 2×). A mutual upright
posture at close range is the classic agonistic configuration and the obvious word is
"boxing", but animals that are moving at four tenths of their usual speed are not
fighting; the figure therefore says **upright display** and never "fight".
(**f**) **The result.** One dot per session: the fraction of that session's displays
started by its leader — the animal that started more of them — against the number of
displays the session contains. The blue rule is the pooled figure over all displays,
**432 of 539 = 80.1%**. The grey band is what a **fair coin** gives at each session
size (95th percentile of max-share under Binomial(n, 0.5), 20,000 draws per n), and it
is drawn because the leader's share cannot fall below 0.5 by construction: a session
with three displays scores 0.67 or 1.00 whatever the animals do. **16 of the 24
sessions with ≥ 5 displays clear that band**; among those sessions the median leader
share is 0.83 (IQR 0.73–0.89) against a null median of 0.57 at the same session sizes.
The pooled figure is insensitive to where the cutoff is put — 79.8% at ≥ 3 displays,
79.6% at ≥ 5, 79.8% at ≥ 8, 79.0% at ≥ 10.
(**g**) **The coupling the rest of the figure rests on.** For every rear onset by one
animal (9,354 across all 56 two-animal Mouse-Dyad-10M sessions, including the 19 that
contribute no display), the probability that the OTHER animal is rearing at each lag
around it, divided by that other animal's own base rate; 1.0 is chance. Lines are
across-session medians, band is p25–p75 across sessions. **Within two body lengths**
the curve reaches 2.9× at the onset and peaks at **4.1× half a second later** — the
time it takes to get up, i.e. the second animal is responding rather than coinciding.
**Further apart** it is flat at 1.05×: same animals, same sessions, same detector, so
the effect requires proximity and is not a shared drive such as a room disturbance or
a drift over the session, which would lift both conditions together. The **null is a
circular shift** of the other animal's rear series (24 per pair), flat at 0.99× with a
tight band; a reshuffle would have been the wrong null, because rears last about a
second and cluster, so scattering onsets destroys the autocorrelation as well and
makes almost anything look significant. Rotation preserves rate, bout duration and
autocorrelation and destroys only the alignment between the two animals — the one
thing under test. The near curve settles at ~1.2× rather than 1.0 at ±5 s: that
shoulder is proximity (animals close at one moment tend to still be close seconds
later, and being close is itself associated with rearing), and the coupling is the
peak above it. A session contributes to a condition only if it supplies ≥ 20 onsets in
it; 21 of 56 sessions fail that for "near" because their animals are rarely within two
body lengths.

Corpus: 539 mutual upright displays from 37 of 56 Mouse-Dyad-10M sessions (2 mice, 5 cameras,
150 fps, ~20 min each), 9 animals in 17 distinct pairings. A display is both animals
reared — neck above 0.75 of that animal's own body length — with tail bases within 2
body lengths, held ≥ 0.25 s, gaps ≤ 0.15 s merged. Body length is each animal's own
median nose-to-tail-base distance. Panels **a–f** use the 37 sessions that contain at
least one display; **g** uses all 56, since a session with no display still has rears
and still tests the coupling.

## The initiator asymmetry: what was tested against it

Every check below was run because the asymmetry in **f** is the figure's one claim
about the animals rather than about the method, and it is the kind of claim that a
detection threshold can manufacture.

**It is not the rearing base rate.** The obvious innocent explanation is that one
animal simply rears more and is therefore up first by arithmetic. It does not hold: a
session's initiation share is uncorrelated with that animal's share of rearing time
(r = −0.01, n = 24 sessions) or of rear bouts (r = −0.06), and the initiation share
departs from 0.5 by a median 0.33 where rearing time departs by 0.08.

**It is not the per-animal height threshold.** A frame counts as reared when the neck
is above 0.75 of *that animal's own* body length, so an animal whose measured body
length is short crosses the threshold earlier and could be recorded as the initiator
for a reason that is pure normalisation. Re-running the whole detection with a single
threshold for both animals — the pair's mean body length — gives the same initiator in
**22 of 24** sessions; with an absolute 60 mm threshold, **24 of 24**. The median
initiation share is 0.83, 0.75 and 0.82 under the three definitions.

**It is not body size.** In the 8 sessions where the initiating animal is the *longer*
of the pair it still starts **79%** of displays. Nor is it rearing ability: over their
own rear bouts the *followers* peak higher than the initiators in absolute terms
(median 118 mm vs 89 mm).

**The leader does not change during the session.** Splitting each session's displays
into its first and second half, the same animal leads both halves in **20 of 20**
sessions with ≥ 8 displays. So "the leader" names a stable role within a session, not
a run of luck at one end of it.

**Formal tests.** Restricted to the 24 sessions with ≥ 5 displays: leader share median
0.83 (IQR 0.73–0.89, range 0.67–1.00), individually above chance by a two-sided
binomial test in 16 of 24 (9 after Holm correction), Wilcoxon against 0.5
p = 9 × 10⁻⁶, pooled 406 of 510 displays (79.6%).

## What this figure deliberately does not claim

**It does not claim dominance.** An asymmetry in who starts a social display is what a
dominance relationship would look like, but no dominance assay was run — no tube test,
no wound scoring, no independent rank — so the caption says *one animal starts most of
them* and stops. Calling it dominance would be an inference from a
single behavioural measure.

**Sessions are not fully independent.** The 37 sessions are repeated recordings of a
smaller number of animal pairs, so the session-level tests above are not 37 independent
draws. This is why the headline number in **f** is pooled over *displays* and why every
session is plotted against its own null rather than summarised as one mean: nothing in
the panel requires the sessions to be independent of each other.

**It does not claim the initiator is the "taller" or "bigger" animal, and an earlier
version of this figure came close to doing so.** That version put "initiator reaches
higher in 75% of displays" on panel c. The statistic is true as stated but invites
three wrong readings and has been removed: the label is assigned *per display*, in
units of each animal's *own* body length, so (i) it names a rank, not a mouse — it
changes hands within a session on about a quarter of displays; (ii) it is not the
bigger mouse — the structurally longer animal reaches higher on only 41% of displays,
and in absolute millimetres the "initiator reaches higher" figure falls from 75% to
68%; and (iii) the initiator is up first *by construction*, so it has had longer to
reach its peak, which makes part of the 75% mechanical rather than behavioural.

**The near/far contrast does not replicate on SLAP-2M, and the reason is geometric.**
Its two-animal sessions give 1.08× near and 0.97× far. Its arena is 3.2 body lengths
across against Mouse-Dyad-10M's 6.9, so "within two body lengths" covers most of the session
there and the far condition is barely a contrast; the corpus also has ~4× fewer onsets
(2,180). The claim in **g** is made for Mouse-Dyad-10M and is not extended.

**Two other analyses were built for panel g and are not shown; both are in the tree
and both deposit their CSVs.** (i) *Height match:* the lower animal's peak height is a
median 0.91 of the higher one's against a within-session shuffled null of 0.86 (95%
0.85–0.87, p < 0.001) — real, small, and not about the animals' relationship
(`panels/fig5_11_height_match.py`, superseded). (ii) *Aftermath*
(`figs/fig5_aftermath.py`, `panels/fig5_11_aftermath.py`): from the display's last
frame the initiator turns away (61° → 88° body-axis angle to the partner over 3 s)
while the follower stays pointed at it (30° → 37°), the initiator's angle being the
larger in 22 of 24 sessions at 1 s (p = 1.2 × 10⁻⁶); neither animal flees (still
within 2 body lengths after 72% of displays at 3 s — but also after 74% of
separation-matched controls, so this is *not* claimed as a finding); and another
display follows within 10 s on 40% of occasions against 18% after matched control
moments (p = 4 × 10⁻⁵). These are reportable but did not earn the panel.

**It is not video-scored.** What the display *is* — assessment, greeting, low-level
agonism — cannot be settled by kinematics. The stillness (**e**) rules out a tussle
and nothing more. No video was scored for this figure.

**37 of 56 sessions contribute.** The other 19 have no display that meets the
definition, not a display that was dropped. Panel **f** draws all 37, but every
per-session statistic quoted above is restricted to the 24 sessions with ≥ 5 displays;
the other 13 hold 29 displays between them and cannot clear the null at any share. Not
restricting raises the "median session share" from 0.83 to 0.889 — a session with one
display scores 1.00 by construction. That inflated number appeared on the previous
version of this figure and is retracted; the number the figure now leads with, 80%, is
pooled over displays and so is not exposed to this at all.

---

## Figure 6 — Datasets

**Across the 74 proofread SLAP-2M sessions, the corpus's own difficulty rating acts on
*whether* a keypoint is detected rather than on *how well*: the per-view miss rate rises
10.8-fold from the easiest to the hardest stratum (5.3% → 57.7%) while the mean error of
the detections that do fire rises 1.30-fold (3.65 → 4.74 px). A keypoint missing in one
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
(c) Keypoints still missing per view **after reprojection recovery**, against the
difficulty rating and the rig size k = 2 to 6, cell values in per cent. A keypoint the
detector misses in one view counts as recovered when the same animal's keypoint is
detected in at least two other cameras of the rig at hand: it can then be triangulated
from those views and reprojected into the view that missed it. Every cell is an exact
closed-form expectation over all C(6, k) camera subsets — no sampling, no per-subset
re-runs — using the same detection-to-reference matching as g, at stride 1. Over the
corpus 26.1% of keypoints are missing per view; recovery is 0% at k = 2 by construction
(one other view cannot triangulate) and rises to 45.7% of misses at k = 6, taking the
residual from 26.1% to 14.2%.
(d) The animal-count control for the difficulty trend: the per-view miss rate re-run
**within** each animal count. All four counts and all 74 sessions enter (1 animal
n = 32, 2 animals n = 35, 3 animals n = 4, 4 animals n = 3), error bars are ±1 s.d.
between sessions where n > 1, and cells resting on a single session are drawn
**hollow** so they cannot be read as measurements. A count occupying fewer than three
difficulty ratings gets bare markers and no connecting line (3 animals occupies only
ratings 3 and 7). The marginal miss rate by count alone is **non-monotone** — it falls
at four animals.
(e) Cross-view identity performance against the same difficulty rating: cross-view
IDF1 of LUC3D's tracker in its previous default configuration (the configuration of
Fig 7's panels b–f), one dot per session over the **42 multi-animal** SLAP-2M sessions,
a box-and-whisker per stratum — median line, IQR box, whiskers to 1.5× IQR, no separate
flier marks because every session is already drawn as a dot — and n printed under every
stratum (10, 3, 10, 3, 3 and 13 sessions at ratings 2–7). Identity holds across most of the rating range and degrades
only in the hardest strata: stratum medians 0.989, 0.923, 0.969 and 0.925 at ratings
2–5, then 0.829 at 6 and **0.649** at 7 — and the rating-7 stratum spans 0.41–0.90
across its 13 sessions, so the hardest rating is also the most heterogeneous. Read
against g: the per-view miss rate rises 10.8-fold over the same rating, so the identity
decline at high difficulty follows the supply of detections to associate. The 32
single-animal sessions are excluded because they hold nothing to associate across
views; difficulty 1 is single-animal only, so its stratum is empty and the axis says
n = 0 rather than hiding the tick.
(f) Corpus composition, transposed (attributes down, corpora across); the SLAP-2M
camera cell reads `8 (6 proofread)` because every SLAP-2M measurement in this paper
uses six.
(g) Raw per-camera detection quality against the difficulty rating, in **three sub-plots
because the three quantities disagree**: keypoints missing (rises 10.81×), error of those
present (**mean** ± s.d. between sessions, with the 95th percentile — the panel names the
statistic on the artwork; the mean rises 1.30×), and the fraction beyond the app's own
20 px reprojection tolerance, as labelled bars (rises 5.72×). n per stratum is printed
under the row.
(h) The measured strata, per difficulty: sessions, keypoints, the **set** of animal counts,
the black/white bedding split, error mean, p95 and p99, and the fraction beyond 20 px.
The animal-count and bedding columns are where a reader can check the confound d controls
for; the error column is the **mean**, the same statistic g plots and the headline quotes.

n: panels d, g, h are **74 SLAP-2M sessions, every frame, 187,134,382 keypoint
comparisons**, six cameras, 15 nodes. Panel c rests on the same 74 sessions and the same
matching at stride 1; panel e is the cross-view identity measurement over the corpus's
42 multi-animal sessions. Panels a and b
are one further SLAP-2M session (difficulty 4, four animals, black bedding). The
130-session, 12,039,174-frame corpus figure in (f) is a **composition** statement: the
56 Mouse-Dyad-10M sessions carry 84% of that frame count and enter no other panel.

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
  miss rate runs 5.3% → 16.7% across ratings 1–5, and within the 35 two-animal sessions
  10.9% → 57.8% across ratings 2–7. And at *matched* difficulty more animals is worse —
  at rating 4, 11.9% / 19.0% / 39.5% for 1 / 2 / 4 animals. So g is neither a pure
  difficulty effect nor a pure animal-count one, and the panel says so. Marginally, miss
  rate by animal count is 12.3% (1), 33.2% (2), 44.4% (3, n = 4) and 39.5% (4, n = 3):
  non-monotone, falling at four animals, whose three sessions are all at difficulty 4, so
  that marginal is as much a difficulty average as an animal-count one.
* **Which deposit panel d reads, and why it is not the other one.** `fig6_detections.json`
  (74 sessions, `detections_only_master_sheet.tsv`, stride 1 — every frame, the shared
  identity-stripped **raw detection** pool) — the same measurement g and h plot, so d is g
  stratified differently. `fig6_difficulty.json` also deposits a `by_animals` table and
  disagrees by half on the two-animal miss rate (21.95% against 33.16%), because it is a
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
  only those six are measured. Mouse-Dyad-10M is a separate five-camera rig.

## Supplementary Note

* **Difficulty is the corpus's own hand-assigned rating**, not a measured quantity, and
  the strata are unevenly sampled (12/13/9/13/10/4/13 sessions). The rating is confounded
  with animal count — stratum 1 is twelve single-animal sessions, stratum 7 is twelve
  two-animal ones — which is why panel d exists and why panel f prints the animal-count
  and bedding composition of every stratum.
* **The "missing, not degraded" mode belongs to that rating; the bedding axis is no
  longer offered as a counterexample.** An earlier version pointed here at a Fig 7
  bedding-invariance panel; that panel was cut from the artwork on 2026-08-13 and the
  invariance claim is retracted, because the detector's training set is overwhelmingly
  black-background, so the white-bedding arm is confounded with out-of-distribution
  detection and the black/white contrast cannot be attributed to association. The
  bedding deposit and its panel script stay on disk, un-plotted; panel h still prints
  each stratum's black/white composition so the confound stays visible.
* **These are agreement with the proofread answer, not absolute accuracy.** The reference
  carries its own reconstruction error, and it comes from the pipeline that produced the
  labels being agreed with.
* **The tail is heavier than the mean implies**, which is why the mean and the 95th
  percentile are both plotted in g and the 99th is tabulated in h: across the strata the
  mean rises **1.30×** (3.65 → 4.74 px), the 95th percentile 1.42× (8.95 → 12.71), the
  99th 1.92× (14.45 → 27.77) and the fraction beyond 20 px 5.72× (0.33% → 1.90%).
  So the hardest sessions do not merely miss more keypoints, they also place a larger
  minority badly — but even that 5.72× is about half the 10.81× rise in outright misses.
  **The statistic is the mean, and the panel names it** ("mean ± s.d."), because the mean
  is what the tail moves and the tail is the point. The median is deliberately not
  reported: it rises only 1.11× (2.88 → 3.20 px) and is the one summary that hides this.
  Both estimators are arithmetically right for their own statistic, so quoting the p50
  ratio anywhere in this figure's text would silently change estimator; `err_p50` stays in
  the deposited CSV and on no artwork.
* Panel a's 3D renders carry no scale bar: they are perspective views of a scene whose
  content spans a large depth range, and the viewport's field of view is not recorded, so
  no single bar would be correct.
* The identity assignment in (b) was checked against the corpus 3D: each of the four
  identities maps to the same corpus track in all six views (centroid agreement
  0.2–15.5 px), so the shared colours are the same animal across views.

---

## Figure 7 — Comparison

**On identical identity-stripped detections, LUC3D is the only method whose identities
survive being pooled across cameras: its IDF1 is unchanged from within-view to
cross-view scoring (0.861 → 0.861, retention 1.00) while per-camera trackers — even
re-run at the most favourable configuration we could give them — keep 0.23 of theirs.**

(**a**) Within-view against cross-view IDF1 for four trackers over 50 full Mouse-Dyad-10M
sessions (5 cameras, 2 mice), drawn as a slopegraph — one line per tracker joining its
within-view mean to its cross-view mean, with the deposited 95% bootstrap CI over
sessions at both ends. Printed ratios are cross-mean ÷ within-mean. The LUC3D line is
the **fresh-anchor** operating point, the tracker as shipped: 0.861 within view to
0.861 cross view (retention 1.00) with 413 within-view ID switches. The **previous
default** configuration, preserved in the deposit, scores 0.749 → 0.749 with 2,071
switches, and the fresh anchor is ahead of it in 38 of 50 sessions on both scorings.
The two per-camera baselines are re-run fairly rather than as shipped (Methods): SLEAP
with its track count capped at the true animal count (`--max_tracks 2`) scores
0.642 → 0.146 (retention 0.23); ByteTrack with track retirement disabled and its output
reduced to 2 identities by a ground-truth-free tracklet stitch of ours scores
0.676 → 0.157 (0.23; its own never-retire knob alone reaches 0.272 within view).
3D-MuPPET is flat at 0.011 → 0.011, but that is a coverage artefact rather than an
identity score: its assignments cover a median 1.3% of a session, and flatness alone is
not the claim. The dashed rule at **1/C = 0.20 is where camera-scoped pooling puts a
per-camera tracker — a property of the scoring convention, not a ceiling and not a
chance level**. Cross-view IDF1 pools all C cameras into one accumulator with one
global identity per animal, so a tracker that labels each camera independently can have
its labelling matched to truth in at most *one* camera. Chance is set by the number of
**animals**, not cameras — with 2 mice a coin-flip cross-view assignment sits near 0.5,
far *above* where the per-camera trackers land.
(**b**) The full within-view IDF1 distribution over 74 SLAP-2M sessions, as a survival
curve: the percentage of sessions scoring at or above each IDF1 threshold, one step per
session. This and every later panel are the **previous default** configuration on
SLAP-2M. Drawn this way rather than as three dot swarms because the trackers separate
most in the **upper tail**, which a median and a jittered cloud both bury — at
IDF1 ≥ 0.9 the counts are 39/74, 22/74 and 10/74 for LUC3D, SLEAP and ByteTrack.
Per-camera-session win counts beneath (LUC3D 269, SLEAP 79, ByteTrack 4, 92 of 444
tied — most ties are single-animal camera-sessions where LUC3D and SLEAP score
identically), and both summaries the deposit asks for: LUC3D within-view mean **0.752**
against median **0.920**. Note this is a *different quantity* from **a**'s "within
view": that is Mouse-Dyad-10M, 50 sessions, 5 cameras; this is SLAP-2M, 74 sessions, 6
cameras.
(**c**) The paired per-session difference in within-view IDF1, LUC3D − SLEAP, by number
of animals in the session: mean with 95% bootstrap CI, **every individual session drawn
as a dot behind its cell**, and n and win count printed under every tick: **+0.142**
(25/32) at 1 animal, **+0.075** (30/35) at 2, **−0.052** (0/4) at 3, **−0.080** (0/3)
at 4. **The two rightmost cells are the two where LUC3D loses**, and with the sessions
visible the reader can weigh them directly: seven multi-animal (≥ 3) sessions, all
below zero, worst −0.152. The 1-animal cell is the largest effect and is not a
cross-view result — there is nothing to associate across views there — so the pooled
figures are printed both ways: over all 74 sessions **+0.091** (55/74, sign test
P = 3.4 × 10⁻⁵), and over the **42 sessions with ≥ 2 animals +0.052 (30/42, sign test
P = 0.008)**.
(**d**) Error composition against a shared ground truth of 15,947,278
keypoint-instances: false positives and ID switches as **percentages of camera-frames**
(denominator 11,726,640 camera-frames — 74 sessions × 6 cameras, summed from the
per-camera-session motmetrics frame counts; raw counts are retained in the deposited
table). Read the small numbers as reliability: an ID switch occurs on 0.0264% of LUC3D
camera-frames, i.e. identity is held on 99.97% of them. False negatives are
deliberately not plotted — they are 98.8–99.3% of every tracker's error budget, so
including them would draw three identical bars and hide the terms a tracker controls;
their share is stated in the panel's footnote instead. LUC3D has the fewest switches
(0.0264% against SLEAP's 0.0308% and ByteTrack's 0.105%) **and** the fewest false
positives (0.317% against 0.531% and 0.435%).
(**e**) Session-level within-view IDF1 against the shared detector's recall, one point
per session for all three trackers, with the IDF1 = recall diagonal. ByteTrack's cloud
(**r = 0.775, R² = 0.60**) is the one that cuts against the panel's claim — "the level
is set by detection" holds for the two good trackers (LUC3D r = 0.990, SLEAP
r = 0.945), not as a law: a tracker whose session IDF1 is only loosely tied to recall
is one whose own failures dominate, and its points scatter visibly off the diagonal.
(**f**) **The measured LUC3D disadvantage**: paired fragmentations per camera-session,
LUC3D − SLEAP, mean with 95% bootstrap CI over the 74 sessions, with the median drawn
beside it because the distribution is skewed (the mean is 4.7× the median, so the
corpus mean is a tail and the typical session is nearly level). **+6.2** [+3.0, +10.4],
median **+1.3**, and SLEAP fragments fewer in **72 of 74** sessions. A fragmentation is
not an ID switch: motmetrics counts one each time a tracked ground-truth track becomes
untracked and is later picked up again — the track breaks and resumes rather than being
reassigned to the wrong animal. For a proofreading tool that is a real cost, and it is
the price of the same conservatism that buys the cross-view result in **a**.

Panel **a** uses the 50 Mouse-Dyad-10M sessions (9 individual mice in 18 pairings) and is the
only panel carrying the fresh-anchor arm; panels **b**–**f** use all 74 SLAP-2M
sessions (6 proofread cameras, 1–4 animals) and the previous default configuration. The
corpus split is printed on panel a itself. (The bedding panel an earlier version
carried here was cut 2026-08-13 and its invariance claim is retracted: the detector's
training set is overwhelmingly black-background, so the white-bedding arm is confounded
with out-of-distribution detection. `panels/fig7_06_bedding.py` and its CSV stay on
disk, un-plotted.)

---

## Provenance

**Every SLAP-2M number in Figure 7's panels b–f comes from
`figs/out/fig7_variant_best.json`'s `slap2m` block — the app's cross-view tracker
(`pose/cross-view-tracker.js`, `runCrossViewTracker`) in its previous default
configuration, re-scored per (session, camera) by `figs/fig7_slap2m_rescore.py`
through luc3d-bench's own `evaluate.eval_camera`. The SLEAP and ByteTrack rows are
copied byte for byte from `luc3d-bench/outputs/PAF_3d_kalman/_eval_baseline.csv`; the
pre-#131 per-frame matcher those panels used to plot (a bench-only arm from 2026-05-15,
seven weeks before `runCrossViewTracker` was merged) is preserved verbatim under
`slap2m_pre131_reference`.** Panel a's Mouse-Dyad-10M numbers come from the Fig 8 harness
deposits behind `data/fig7/fig7a_within_vs_cross_variant.csv`. This provenance
discipline matters because `luc3d-bench/outputs/metrics/` contains three mutually
inconsistent runs under the single label "luc3d", and **none of them is the app's
tracker**:

| file | LUC3D IDF1 | fragmentations | what it actually is |
|---|---|---|---|
| `metrics/per_camera_session_metrics.csv` (May 18 06:55) | 0.738301 | 7.27 | evaluation of `outputs/luc3d_results_v2/` — a **post-processed variant** |
| `metrics/by_tracker.csv`, `by_animals.csv`, `by_bedding.csv`, `by_camera.csv`, `session_wins.csv`, `session_pairwise.csv`, `worst_idf1_luc3d.csv` (May 18 01:55) | 0.736490 | 7.52 | aggregates of a **third** run whose per-camera file was overwritten and no longer exists |
| `metrics/auc_summary.tsv` (May 19) | 0.7383 | — | derived from the variant file above |
| `PAF_3d_kalman/_eval_baseline.csv` | 0.736035 | 28.11 | evaluation of `outputs/luc3d_results/` — the **pre-#131 bench arm** (retired; preserved as `slap2m_pre131_reference`) |

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

Cross-view IDF1 does not exist in the SLAP-2M corpus at scale — only Mouse-Dyad-10M has a
proofread cross-view metric over full sessions at n > 1 — which is why the figure uses
two corpora: panel a's cross-view claim is Mouse-Dyad-10M, panels b–f's within-view comparison
is SLAP-2M.

**Consequence for the numbers.** Every SLAP-2M LUC3D figure quoted here is the app's
own tracker and therefore differs from earlier drafts, which quoted the retired
pre-#131 bench arm. The camera-session win counts in panel **b** (LUC3D 269, SLEAP 79,
ByteTrack 4, tied 92 of 444) **replace** both the pre-#131 counts (229 / 173 / 4, 38
tied) and the 275 / 157 / 12 in `metrics/session_wins.csv`, one of the stale 01:55
aggregates. Similarly the pooled paired difference is **+0.091** (previously +0.075 on
the retired arm) and the 3- and 4-animal cells are **−0.052** and **−0.080** (previously
−0.030 / −0.028).

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
global identity per animal, and the pooling is camera-scoped: a per-camera tracker's ids
stay distinct across cameras, because the tracker did nothing to earn the link. Under
that convention a tracker with no cross-view association mechanism lands near 1/C on the
cross-view metric (0.20 at C = 5, 0.167 at C = 6) — a property of the scoring convention
rather than a ceiling, and it is why the
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
producing nothing consistent is trivially consistent (and its 0.011 is a coverage
artefact besides: its assignments cover a median 1.3% of a session and every unlabelled
frame scores as a miss). Flatness alone is not the claim. The per-camera trackers land
near the 1/C rule under camera-scoped pooling (SLEAP 0.642 → 0.146, ByteTrack
0.676 → 0.157, against 1/C = 0.20): the rule is **a property of the scoring convention,
not a ceiling and not a chance level** — chance for a cross-view identity assignment is
set by the number of animals (≈0.5 with 2 mice), which sits far above it, so "below
chance" would be both wrong and weaker than what the data supports.

**LUC3D's flatness is retention 1.00 to the printed precision, not literal identity.**
The fresh anchor's deposited means are 0.8611 within view and 0.8613 cross view (the
cross figure marginally higher; ratio 1.0002); on the previous default arm the largest
per-session |within − cross| across the 50 sessions was 0.0070. The collapse ratios of
the re-run baselines are 0.228 for capped SLEAP and 0.231 for constrained ByteTrack.
LUC3D is ahead of every other tracker on cross-view IDF1 in **50 of 50** sessions and
on within-view IDF1 in **50 of 50** (exact sign test P ≈ 1.8 × 10⁻¹⁵ each).

**Must be stated as a limitation: LUC3D does not lead on within-view IDF1 at higher animal
counts, and the n is small.** Paired per-session difference against SLEAP (SLAP-2M,
previous default configuration):
1 animal **+0.142** [+0.100, +0.184], 25/32 sessions won (n = 32);
2 animals **+0.075** [+0.052, +0.099], 30/35 (n = 35);
3 animals **−0.052** [−0.068, −0.029], **0/4** (n = 4);
4 animals **−0.080** [−0.152, −0.021], **0/3** (n = 3);
**≥ 2 animals pooled +0.052**, 30/42 (n = 42), sign test **P = 0.008**;
all 74 sessions **+0.091** [+0.066, +0.117], 55/74, sign test P = 3.4 × 10⁻⁵.
**The pooled +0.091 must not lead**: it is carried by the 1-animal cell, where there is
nothing to associate across views, so whatever produces +0.142 there is detection gating
and gap handling rather than cross-view association. In the stratum where the claimed
mechanism can operate the paired advantage is +0.052 — it clears a sign test, but the
two cells where cross-view association should help most are negative. The ≥ 2 figure is
the n-weighted mean of the three deposited cell means,
(35 × 0.074837 + 4 × −0.051852 + 3 × −0.079704)/42 = 0.051733, so it can be checked by
hand against `fig7_variant_best.json`; no bootstrap interval is quoted for it, and the
exact sign test is the statistic given.
The direction of the 3–4 animal loss is robust in the sense that SLEAP wins every one of
those seven sessions individually, and we say so. But the load-bearing cells are **4 and
3 sessions** and they are confounded: all three 4-animal sessions are black bedding at
difficulty 4, and three of the four 3-animal sessions are black bedding. The claim of this
paper is cross-view identity consistency, not per-camera superiority.

**What within-view IDF1 actually measures (panel e), and why it bounds how much the
3–4 animal result can mean.** Across the 74 sessions, session-level LUC3D within-view IDF1
correlates with the *shared detector's* recall at **r = 0.990, R² = 0.98** (n = 74;
SLEAP r = 0.945, ByteTrack r = 0.775), and panel **d** shows why: against a common ground
truth of 15,947,278 keypoint-instances, detector false negatives are 98.8–99.3% of every
tracker's total error (LUC3D 5,701,484; SLEAP 5,509,232; ByteTrack 5,627,679). Two
consequences we state ourselves. First, MOTA cannot discriminate between these trackers —
it is dominated by a shared term — so excluding it is principled rather than convenient.
Second, at n = 4 and n = 3 with 98% of between-session variance attributable to detector
recall, the 3–4 animal difference is close to a measurement of the detector rather than of
the association method. Within that same shared error budget LUC3D produces the fewest
false positives — **37,126 against SLEAP's 62,320 (40% fewer) and ByteTrack's 51,049** —
at essentially equal false negatives.

**Two honest negatives.** (i) **LUC3D fragments more than SLEAP** — paired +6.2
fragmentations per camera per session, median +1.3, 95% CI [+3.0, +10.4], SLEAP fewer in
72 of 74 sessions, n = 74, Wilcoxon P ≈ 2 × 10⁻⁹. This is **panel f**, which exists
because the deposit's own caveat says it must ("Stated, not hidden") and because a figure
that prints every other loss of its method was silently dropping the one clean,
corpus-wide result that goes against it. Fragmentation and switching trade off: LUC3D ends
a tracklet where an appearance-based tracker would guess. The mean is 4.7× the median,
so the corpus mean is a tail and the typical session is nearly level; only the paired
LUC3D − SLEAP difference is deposited and on the artwork. (ii) The corpus **mean**
understates LUC3D and hides
its shape — within-view IDF1 mean 0.752 against median 0.920 — because a minority of
sessions are detection blackouts. The distribution is the result: LUC3D clears IDF1 ≥ 0.9
on **39 of 74** sessions against SLEAP's 22 and ByteTrack's 10, and ≥ 0.7 on 50 against
40 and 24. The separation is largest in the upper tail, which is exactly what the mean
conceals.
