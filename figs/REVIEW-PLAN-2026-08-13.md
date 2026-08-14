# Figure review plan — meeting notes of 2026-08-13, formalised

> **STATUS 2026-08-15 (overnight loop).** Done and rendered: X.1 sweep across Figs
> 1/2/3/4/6 (entity hues off quantities, level() for ordered strata, identity slots
> matching the screenshots), F1.1-F1.3, F2.1, F2.5, F2.7, **F2.6b MEASURED AND DRAWN**
> (fig2_cams_identity.json, k=5 gate exact; panel fig2s1: 0.67 -> 0.74 -> 0.75 -> 0.75,
> the 2->3 jump is the story), F3.1, F3.2, F7.1, plus tonight: 3a unboxed, 3b cut
> (cost function now in METHODS.md), 3c fresh-anchor-only without count labels, 3d
> exhaustive-vs-fresh-anchor with denominator-labelled reference rules, 3e decluttered,
> 7a fair baselines + amber experimental arm + coverage caveat + corpus pointer, three
> stratified supplementary panels (6s4 by-animals, 6s5 by-camera, 7s3 by-difficulty)
> answering the "more plots by difficulty/camera/animals" ask from existing deposits.
> FIGURE-LEGENDS.md/.txt and METHODS.md synced by a dedicated agent (fair baselines,
> IDA, exhaustive denominators, the association cost in the CODE's form). Three
> adversarial review rounds applied; lint at the 2 pre-existing issues.
>
> **Placement proposals for Eric** (supplementary letters until placed): fig2s1 ->
> Fig 2 bottom row beside 2c (geometry + identity halves of how-many-cameras); fig7s3
> -> Fig 7 beside 7c (difficulty companion to the animal-count split); fig6s4 ->
> REPLACES 6d or stays supplementary (same cells, better encoding -- placing both
> would put one dataset in the figure twice); fig6s5 -> Fig 6 row c/d as the third
> split once its legend entry lands.
>
> **Still blocked on Eric:** F2.2/2a-3D re-render from sideL (needs the app), F7.3
> recovery tolerance, X.2 px->cm scale plane, F3.3 "the square" reading, F3.4 nodes
> timing. The uncapped 3x5/4x3 exhaustive re-run is at 6/7 sessions in flight.

Every item below is one reviewer comment, restated against the panel and the script that
produces it, with what would actually change and what it costs. Panels are named by their
artefact in `figs/figures/figN/`; scripts by their file in `figs/panels/`.

**How to read an item.**

- **Asked** — the comment, as given.
- **Reading** — what I take it to mean. Where a comment admits more than one reading I say
  so and put it in *Open questions* rather than guessing quietly.
- **Change** — the concrete edit.
- **Cost** — `redraw` (panel script only, minutes), `re-render` (needs a new app
  screenshot/render), `re-measure` (needs a compute run, hours), `new experiment` (needs a
  measurement that does not exist yet, and a design decision first).

A short **priority** section at the end sequences them. Items marked **BLOCKED** need a
decision before anyone can start.

---

## 0. Cross-cutting — colour, and it is the biggest single item

### X.1 One meaning per colour, and stop reusing the palette across unrelated panels
**PARTLY DONE (2026-08-14).** The mechanism is in: `src/style.py` gained `identity(i)`, which mirrors the app's own `IDENTITY_COLORS` from `pose/pose-data.js` so a schematic and a screenshot name the same animal the same way, and `level(i, n)`, a viridis ramp for ORDERED non-entity series so cost-weight ratios and camera counts stop borrowing entity hues. `identity()` darkens the app's screen primaries to a measured 3.53:1 minimum against white (`#00ff00` is 1.4:1 and vanishes in print). Applied so far to Fig 1a's icons only; the sweep across the remaining panels is still to do.


**Asked.** *"Use different colors for all these different plots, the colors are reused too
much. If the colors are related to ID then use those, but otherwise all the plots can't
have the same colors unless they relate to each other. Use the mimic-mjx colour palette
though."* Also *"watch the colour matching the instance"* and *"Fig 3, not all orange
lines, but the colours should be IDs, just re-use the same colours from the previous
slides and luc3d IDs."*

**Reading.** Not a request for new colours — the set stays `figures-mimic-mjx`'s Set2,
which `figs/src/style.py` already implements. The complaint is that one hue currently
carries several unrelated meanings across the figure set, so a reader learns "teal = us"
on Fig 3 and then meets teal as "a cost-weight level" on another panel. Two rules follow:

1. **Identity colours are reserved.** If a panel shows animal identities, its colours are
   the identity palette, and the *same* animal keeps the *same* colour in every panel of
   every figure where that frame appears (Fig 1b/1c, Fig 2a, Fig 6b).
2. **Entity colours are reserved.** `entity()` already pins LUC3D/SLEAP/ByteTrack/3D-MuPPET
   set-wide. Any panel whose series are NOT identities and NOT those entities must draw
   from a different, non-colliding slot of the palette — or better, stop using hue for
   that axis at all (line style, marker, position) so hue stays meaningful.

**Change.** Add a `role` layer to `figs/src/style.py` beside `entity()`:
`identity(i)`, `entity(name)`, `level(i)` (for ordered non-entity series, e.g. cost-weight
ratios, camera counts — a sequential ramp, not Set2 categoricals), and make panels declare
which they are using. Then sweep every panel. Audit first, edit second: the sweep should
start from a printed table of "panel → hue → meaning" so the collisions are visible before
anything moves.

**Cost.** `redraw`, but broad — roughly every panel script. Half a day, and it should be
one commit so the set never sits half-converted.

### X.2 Pixels → centimetres
**NOT STARTED** — blocked on the open question below.


**Asked.** *"Pixels to centimeters."*

**Reading.** Reprojection error in px is a sensor-space unit a biologist cannot act on;
the reader wants a physical scale. This affects Fig 2c (error CDF), Fig 2d (already mm),
Fig 4b/4d (px), Fig 6c (px), and the 20 px tolerance quoted throughout.

**Change.** Two options, and they are not equivalent:

- **(a) Add a secondary axis** in mm/cm alongside px, using the measured px→mm scale for
  the rig. Cheap, honest, keeps the native unit that the detector actually works in.
- **(b) Convert outright.** Cleaner to read, but px→mm is depth-dependent — the conversion
  is exact only on the plane the scale was measured at, and the corpus has animals rearing
  ~90 mm off the floor.

**Recommendation: (a).** State the scale factor and its measurement plane in the legend.
Where a quantity is genuinely 3D (Fig 2d, Fig 4c) it is already mm and should say **cm**
only if the numbers are large enough to warrant it — 7.18 mm is better read as mm.

**Cost.** `redraw` + one measurement of the scale factor per rig (probably already in the
calibration; check before measuring anything).

**Open question.** Which plane do we quote the scale on — the arena floor, or the mean
animal height? They differ by roughly 10% at this rig geometry.

---

## 1. Figure 1 — the pipeline and what the tool is

### F1.1 Export is a contribution and should be marked as one
**DONE (2026-08-14).** `export` is contributed; the "this work" bracket now runs to the end of the row.


**Asked.** *"Fig 1a export is part of the pipeline! It should be highlighted in green that
way."*

**Reading.** `fig1_01_pipeline.py`'s `STAGES` marks three stages as ours (cross-view re-ID,
triangulate, proofread 3D) and leaves `export` unmarked, so the pipeline reads as ending
in someone else's format. Emitting **SLP 2.8 with the columnar `/session_data`** is our
work and is what makes the 3D readable by SLEAP at all.

**Change.** Set `export`'s contribution flag to `True` in `STAGES`. The "this work" bracket
is drawn from the contiguous run of contributed stages, so extending it to the last stage
also removes the visual break. Note the reviewer says *green* — see X.1: if green becomes
"ours", it must not also be a series colour elsewhere in the set.

**Cost.** `redraw`, one line plus the bracket geometry.

### F1.2 Split "videos + calibration" into two inputs
**DONE (2026-08-14).** Stage 1 is `videos`; calibration is a labelled arrow entering the TRIANGULATE chevron from above, which is where it is actually consumed. Drawn above the row because below it the label landed on the "triangulate" caption.


**Asked.** *"Just videos and make calibration separate?"*

**Reading.** The first stage currently reads `videos + calibration / N cameras, .toml`,
which implies calibration is an input you already have. It is a separate artefact with a
separate provenance, and for many labs a separate step.

**Change.** Either (a) two stacked input boxes feeding stage 2, or (b) `videos` as the
stage and `calibration (.toml)` as a labelled side-input arrow entering at the
triangulation stage — which is where it is actually consumed. **(b) is more accurate**: 2D
pose does not need calibration, triangulation does.

**Cost.** `redraw`, geometry work in `src/diagram.py`.

### F1.3 Panel a must show the many-cameras → one-volume collapse
**DONE (2026-08-14).** Three new icon kinds in `src/diagram.py`: `tiles2d` (three camera tiles, two animals each, ALL ONE COLOUR), `tilesid` (same tiles, two identity colours, consistent tile to tile), `volume3d` (one 3D volume, same two colours). The glyphs are wide rather than square -- three tiles in a 0.5-unit box would be 1.5 mm each. `instances3d` was ALSO repointed at `identity()`: it had been drawing its two animals in SET2[0]/SET2[1], i.e. teal and salmon, the reserved hues for "this work" and "its comparator".


**Asked.** *"In fig1a it would be helpful to show that we are using 2D pose for multiple
cameras, then doing ID tracking on multiple cameras, and then the triangulation step
collapses them into 1 3D volume. Rather than just looking like we have 1 2D pose that we
are tracking and then identifying. So we should show multiple squares with two animals in
it that are all the same colour for 2D pose, then cross-view re-ID would show those
multiple squares with the two animals with different colours, then in the triangulation it
is one 3D volume with the same matching ID colours."*

**Reading.** This is the most substantive Fig 1 change and it is a correction of the
figure's *claim*, not its looks. As drawn, the icon row shows one pose per stage, so the
figure asserts a single-view pipeline — exactly the thing the paper says it is not.

**Change.** Rebuild the three middle icons in `src/diagram.py`:

| stage | icon becomes |
|---|---|
| 2D pose | **N camera tiles** (3 is enough to read), each with two animals, **all one colour** — identity does not exist yet |
| cross-view re-ID | the **same N tiles**, animals now in **two identity colours**, consistent tile to tile |
| triangulate | **one 3D volume**, two animals, **the same two identity colours** |

The colour story then carries the whole argument without a word of text: one colour → two
colours across tiles → two colours in one box. This is also the cleanest possible statement
of X.1's rule.

**Cost.** `redraw`, but real icon work — half a day. Highest value-per-hour item in the
whole list.

---

## 2. Figure 2 — the labelling protocol

### F2.1 Label the anchor cameras in the schematic

**Asked.** *"Fig 2a2, if you labelled, the diagram should label the cam 2 and cam 6."*

**Reading.** Panel a's sub-element 2 shows the two labelled anchor views without naming
them, so the reader cannot connect them to the rig or to the angle argument in 2d.

**Change.** Print the camera names on the anchor tiles (the legend says cam 1 topB and
cam 6 sideL — **confirm which two the render actually uses** before labelling; the comment
says "cam 2 and cam 6", the legend says 1 and 6, and one of those is wrong).

**Cost.** `redraw`. **Open question:** which pair is in the current render?

### F2.2 The 3D view in panel a is upside down

**Asked.** *"Fig 2a2 bottom, 3D from camera is upside down! Do that from the sideL view or
something."*

**Reading.** The 3D viewport in the protocol panel is rendered from a camera pose that puts
the animal inverted, which reads as a bug in the tool.

**Change.** Re-render that viewport from `sideL` (or any camera with the world up-vector
up). This is an app render, so it needs the session re-opened and re-captured, not a
matplotlib change.

**Cost.** `re-render`.

### F2.3 Panel a's fourth element must match panel b

**Asked.** *"Fig 2a4 should match Fig 2b."*

**Reading.** The per-view error split drawn inside panel a and the quantity plotted in
panel b are the same thing shown two ways, and they currently disagree in units, colours or
both, so the reader cannot tie them together.

**Change.** Make a4 use panel b's quantity, scale and colours exactly. Pairs with F2.5 —
if b's y-axis changes, a4 changes with it.

**Cost.** `redraw`, after F2.5 is settled.

### F2.4 Colour-code panel b to panel a, and add a cartoon

**Asked.** *"Fig 2b should be colour coded to 2a and have a cartoon."* And *"Fig 2c make a
cartoon."*

**Reading.** Both quantitative panels need a small inset schematic showing what is being
counted, and b's series colours must be the ones panel a uses for anchor vs accepted views.

**Change.** Add a two-tile cartoon to b (anchor view labelled by hand vs accepted view) and
to c (the reprojection being compared against that view's own detection). Reuse the icon
vocabulary from F1.3 so the whole figure set speaks one visual language.

**Cost.** `redraw` + icon work.

### F2.5 Y axis should be labour **saved**, not placements made
**DONE (2026-08-14).** The panel plots `free = CN - aided` with the hand-labelling ceiling above it, and the measured rig reads **43 of 75 free, 57%, 2.3x fewer placements** -- all three framings of one number. Both columns are deposited, so the old framing is recoverable from the CSV. The two tolerances moved into the key: on this quantity the curves converge at the right edge and both end-labels landed on a stroke.


**Asked.** *"Instead of the y axis being manual placements per frame, labor-free labels per
frame."*

**Reading.** Panel b currently plots the cost (placements you must still do). The reader
wants the benefit (labels you get for free). Same data, inverted framing, and the inverted
one is the paper's actual claim.

**Change.** Plot `labour-free labels per animal per frame = CN − aided`, i.e. the
reprojections accepted without a human touch, with the total `CN` as a reference line. The
2.3× saving is then a ratio the reader can read off directly rather than infer.

**Cost.** `redraw`. Note this changes the panel's headline number's *presentation*, not its
value — say so in the legend so it cannot look like a new measurement.

### F2.6 Add "cameras vs error" and "cameras vs switches" — the how-many-cameras question

**Asked.** *"# of cameras per switches"*, *"Fig 2 # of cameras vs error, # of cameras vs
switches"*, *"If you have 2 cameras to 4 cameras that is a major difference; if you have
lots of cameras and add one, not huge difference. To answer the how many cameras
question."* And *"# of cameras, median reprojection error per view"*, *"justifying the
extra data."*

**Reading.** The reviewer wants one panel that answers "how many cameras do I need to
buy?", showing the diminishing return. Half of it exists: **Fig 4b is already
cameras-vs-error** (4.32 → 3.66 → 3.34 px at 2, 3, 4 cameras, held out of the solve). The
missing half is **cameras vs identity switches**, which has never been measured.

**Change.** Two parts.

- **(a) Move or mirror the error curve.** Fig 4b answers the question but sits in the
  triangulation figure where a reader asking about rig design will not look. Either move it
  to Fig 2 or draw the same deposit in both. *No new measurement.*
- **(b) Measure cameras vs switches.** This is a **new experiment**: re-track each session
  with each camera subset and count switches. Cost is the issue — all subsets of 5 cameras
  is 26 per session × 50 sessions = 1,300 tracking runs at ~30–45 min each, which is not
  feasible. Feasible designs:
  - one representative subset per k (k = 2..5), 50 sessions → 200 runs;
  - or 3 random subsets per k on 15 sessions → 180 runs, with a spread band.
  Either is ~4–7 days of box time at current throughput, or overnight if parallelised
  across the free cores once the SLEAP re-run finishes.

**Cost.** (a) `redraw`. (b) `new experiment`, and it needs the design decision above first.

**BLOCKED** on: which subset design, and whether this lands in Fig 2 or stays in Fig 4.

### F2.7 Panel d: cut the text, state the geometry finding
**DONE (2026-08-14).** Gone: the "comparison floor" gloss and the three-line in-sample-band note (a band fitted and scored on the same ten pairs is descriptive, not a test -- it is in the legend now). Kept: the floor value, `k`, the law's name, the two pairs it misses, the two extremes. Shortening the floor label moved its box into the band and lint caught it at 9% inked, so it now sits at the LEFT end where the law is steepest.


**Asked.** *"Fig 2d anchor-pair angle deviation reduces error. Get rid of a lot of the
writing on there."*

**Reading.** The panel is right but over-annotated; the reader should see "anchor pairs
that subtend a wider angle give lower error" and the `k/sin θ` law without reading a
paragraph.

**Change.** Strip to: the dots, the `k/sin θ` curve, the ±25% band, the all-five-view
floor, and **one** short annotation. Move the derivation to the legend. Note this panel
already has the mm unit X.2 asks for.

**Cost.** `redraw`.

---

## 3. Figure 3 — greedy vs exhaustive association

### F3.1 Colour by identity, not by arbitrary series hue

**Asked.** *"The Fig 3 not all orange lines, but the colours should be IDs, just re-use the
same colours from the previous slides and luc3d IDs."*

**Reading.** Panels a/b/c are schematics of the association problem, drawn in one accent
colour. Since they depict *animals being assigned identities*, the animals should carry the
identity palette — the same one Fig 1b/1c and Fig 2a use.

**Change.** Recolour the schematic elements to identity colours in `fig3_01_association.py`
and `fig3_02_cost_terms.py`; keep non-identity structure (rays, boxes, brackets) in neutral
ink/grey. This is X.1 rule 1 applied.

**Cost.** `redraw`.

### F3.2 Re-order panel a, and bring c alongside

**Asked.** *"For 3a move greedy under exhaustive and then c can go next to it."*

**Reading.** Panel a currently places the two search strategies side by side, which spends
width; stacking them (exhaustive above, greedy below) frees the right-hand space for panel
c's hypothesis-count curves, which is the quantitative version of the same contrast.

**Change.** Stack a's two strategies vertically; move c into a's row in `assemble.py`'s
`LAYOUTS[3]`. Check the row-width guard — the assembler refuses rows over 180 mm.

**Cost.** `redraw` + layout.

### F3.3 Panel e should use a TP/(TP+FP+FN)-style score

**Asked.** *"For 3e use the square for True Positives vs TP + FP + FN."*

**Reading.** I read this as: replace (or accompany) 3e's IDF1 axis with a
**Jaccard-style accuracy**, `TP / (TP + FP + FN)` — one number that folds in both error
kinds, with no harmonic-mean subtlety, on the same 0–1 scale. It is computable from the
same accumulators (motmetrics gives all three counts) and is close in spirit to the IDA
number we just added for Fig 7.

**Cost.** `re-measure`, but cheap: the tracking is cached, only the scoring pass re-runs
(~1 h for the 8-session grid; the 50-session grid is 1.3 h per reduced row).

**Open question — this is the one I am least sure I read correctly.** "The square" might
mean (i) the metric above, (ii) drawing the sweep as a heat-map square rather than lines,
or (iii) R². Please confirm before anyone measures.

### F3.4 Panel f: animals × cameras, and what about nodes?

**Asked.** *"For 3f: animals x cameras. What about nodes?"*

**Reading.** The timing panel is currently a per-configuration bar chart. Two requests: lay
the configurations out as an **animals × cameras grid** so the scaling is visible in two
dimensions rather than read off labels; and answer whether cost scales with **node count**,
which is not measured anywhere.

**Change.** (a) Re-lay f as a small grid/heat-map, animals on one axis, cameras on the
other, cell = measured time per frame. (b) Add a node-count series: the exhaustive method's
cost is `(A!)^C` and independent of nodes, while ours is `O(C·A³)` per frame with a
per-node triangulation cost — so **the honest expectation is that nodes are linear and
uninteresting**, and one short measurement settles it.

**Cost.** (a) `redraw`. (b) `new experiment`, small — re-run the timing harness at 3–4 node
counts on one configuration, hours not days.

---

## 6. Figure 6 — corpus and difficulty

### F6.1 Difficulty × number of cameras, as a surface

**Asked.** *"Fig 6c difficulty by number of cameras, make it a 3D plot, recover from
garbage to something."*

**Reading.** Panel c shows detection quality against difficulty rating. The reviewer wants
the second axis — **how many cameras you have** — because the paper's real claim is that
adding cameras rescues hard sessions. "Recover from garbage to something" is the finding
they expect to see: at the worst difficulty stratum, going from 2 to 6 cameras should take
a session from unusable to usable.

**Change.** Compute the metric (miss rate, or the recovered-keypoint rate from F7.3) over
`difficulty × n_cameras` and draw it. **I would push back on the 3D surface**: a 3D
perspective plot makes values unreadable at print size and is exactly what reviewers
usually ask to be removed. Recommend a **2D heat-map** (difficulty on x, cameras on y,
colour = the metric) with one line-plot inset for the worst stratum, which shows the
"garbage → something" recovery directly. Offer both and let the room choose.

**Cost.** `new experiment` — the per-camera-subset metric does not exist. Shares its
compute with F2.6(b) and F7.3; **design all three as one run**.

---

## 7. Figure 7 — tracking and identity

### F7.1 Cut the bedding panel
**DONE (2026-08-14).** Cut from `LAYOUTS[7]`; c-g re-lettered to b-f across the panel scripts, their deposited CSVs, `TITLES`, `FIGURE-LEGENDS.md` and 7a's `c-g: SLAP-2M` pointer. `fig7_06_bedding.py` still runs and now saves as **`fig7s2_bedding`** -- a supplementary letter, so two files do not both claim "b". As predicted this also removed the last panel plotting the retired pre-#131 tracker: **the figure no longer carries two tracker generations under one name.**


**Asked.** *"Fig 7b bedding invariance — don't go down that road because most of the
training is black background."*

**Reading.** The panel claims invariance to bedding colour, but the detector's training set
is overwhelmingly black-background, so the white-bedding arm is confounded with
out-of-distribution detection. The claim is not defensible and invites a reviewer to make
exactly this point.

**Change.** Remove `("b", "bedding")` from `LAYOUTS[7]` and re-letter c–g. Keep
`fig7_06_bedding.py` and its CSV on disk, un-plotted, as Fig 8's dropped panels are — the
measurement stays reproducible, it just stops being a claim.

**Side effect worth naming.** This **resolves the open inconsistency** flagged in
`pick_up_8_12.md`: 7b is the last panel still plotting the retired pre-#131 tracker, so
cutting it removes the two-tracker-generations-under-one-name problem without any further
work.

**Cost.** `redraw` + re-lettering (touches `TITLES`, `FIGURE-LEGENDS.md`, and every
cross-reference to panels c–g in the panel docstrings).

### F7.2 Add accuracy

**Asked.** *"Fig 7 add accuracy!"*

**Reading.** IDF1 does not answer "what percentage does it get right", which is the first
question anyone asks. **This is already measured** — `figs/fig8_ida.py`, added today:
`IDA = idtp / num_matches`, "of the detections matched to a real animal, the fraction
carrying the correct identity". The 4-session pilot gives IDA 89.6% pooled for the fresh
anchor, with false-positive detections at **0.026% of matches**, so IDA and IDP are
effectively the same number on this corpus (92.3% over the 50 sessions).

**Change.** Add an accuracy row or panel to Fig 7 — per-tracker IDA beside IDF1. Report it
**with its distribution**, because the pilot shows the sessions are bimodal: three of four
at exactly 100%, one at 56.6%. A bare mean would be the most misleading number in the
figure.

**Cost.** `re-measure` (running now for the fresh anchor; the shipped cell and the baseline
arms need the same pass) then `redraw`.

### F7.3 Reprojection recovery of false negatives

**Asked.** *"What percent of all frames have all 8 cams with reprojections with many false
negatives, how much are we recovering? % false negatives recovered from reprojections, %
false negatives from predictions."*

**Reading.** The strongest unmade argument in the paper. The detector misses keypoints —
Fig 6 shows the miss rate rising 10.8-fold with difficulty, and Fig 7's error budget shows
false negatives are 98.8–99.3% of every tracker's error. But once an animal is triangulated
from the cameras that *did* see it, the reprojection into the camera that missed it
**fills that keypoint back in**. Nobody has measured how much is recovered. Two numbers:

- **% of ground-truth keypoints missing from the 2D predictions** (the detector's loss) —
  partly in Fig 6, needs restating per camera-frame;
- **% of those recovered by reprojection** within tolerance — new, and the payoff number.

Plus the coverage framing: what fraction of frames end up with **all cameras** carrying a
usable keypoint after reprojection, versus before.

**Change.** New measurement + new panel. Definitions must be pinned first: recovered
"within tolerance" of what (the 20 px app tolerance? 10 px as in Fig 2?), and scored
against which ground truth (proofread 2D per camera).

**Cost.** `new experiment`, medium — it reuses the Fig 2 machinery (triangulate from a
subset, reproject into a held-out view, compare to that view's own GT), so it is closer to
"a new aggregation of an existing pass" than a new harness. Shares compute with F2.6(b)
and F6.1.

**BLOCKED** on the tolerance and ground-truth definitions.

---

## New measurements, as one programme

Three items (F2.6b, F6.1, F7.3) all need the same thing: **per-camera-subset re-runs over
the corpus**. Running them as three separate passes would triple the cost. One run should
emit, per session and per camera subset: triangulation error in a held-out view, ID switch
count, and the keypoint recovery counts. Design it once, and the three panels are three
aggregations of one deposit.

Rough cost at current box throughput (~30–45 min per camera-session for tracking, ~6 min
per session for scoring): a 4-subset-per-k design on 15 sessions is an overnight run; the
full 26-subset design on 50 sessions is not feasible and should not be attempted.

**Do not start this until the SLEAP 2-track re-run finishes** — it currently owns most of
the box.

---

## Open questions

1. **F3.3** — "use the square for TP vs TP+FP+FN": the Jaccard-style metric, a heat-map
   layout, or R²?
2. **F2.6** — which camera-subset design, and does the cameras-vs-error curve move into
   Fig 2 or stay in Fig 4 with a pointer?
3. **F6.1** — 3D surface as asked, or the 2D heat-map I would recommend at print size?
4. **F7.3** — recovery tolerance (10 px, 20 px, or the mm equivalent from X.2), and is the
   denominator all GT keypoints or only those in frames where the animal is triangulable?
5. **X.2** — which plane is the px→cm scale quoted on?
6. **F2.1** — which two cameras are the anchors in the current render (the comment says 2
   and 6, the legend says 1 and 6)?

---

## Suggested order

**First, this week — cheap, high value, no compute:**
F1.3 (the many-cameras collapse), F1.1, F1.2, F7.1 (cut bedding — also clears the tracker
inconsistency), F2.5, F2.7, F3.2, F2.1/F2.2/F2.3.

**Second — the colour sweep:** X.1 as one commit, after the panels above have settled, so
it is done once.

**Third — measurement:** F7.2 (already running), then the combined subset programme
(F2.6b + F6.1 + F7.3) once the box is free and the four open questions above are answered.

**Last:** X.2 units, F3.3, F3.4b — each waits on a decision rather than on compute.
