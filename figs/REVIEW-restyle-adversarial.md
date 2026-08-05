# Hostile adversarial review — the restyled `figs/` set vs `figs/legacy/`

**Audited state.** Two builds were audited. The composites committed at **06:24 UTC**
(the state at the start of this review) and a full rebuild that landed at
**06:49–06:51 UTC** while the audit was running. Where a finding was fixed between
the two, it is marked `[FIXED 06:49]` and kept, because in every such case the
*mechanism* that produced it is still in the tooling and will produce it again. All
composite screenshots referenced below are the 06:51 build unless stated. Panel
sources were being edited concurrently, so re-verify each finding against a fresh
`make_figures.py` run before acting.

Verification commands used throughout:

```bash
cd figs
.venv/bin/python lint_text.py                  # text collisions in rendered PDFs
.venv/bin/python -c "import fitz; d=fitz.open('figures/figN/figN.pdf'); print(d[0].rect)"
# numbers: every recomputation below is from out/*.json with the panel's own aggregation
```

---

## The ten things worth fixing first

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | **Every figure-level provenance footer in the set is gone.** Legacy figs 2–7 each carried a footer naming corpus, n, keypoint count and the caveats. `assemble.py` adds *only* panel letters and no panel draws a figure footer. **Fig 4 now carries zero provenance of any kind** — no corpus, no n, no stride, no calibration count. | all figs; worst fig4 | BLOCKER |
| 2 | **Fig 3b (legacy) — the association-cost schematic with the two printed cost equations — was deleted, not restyled.** The 2D and 3D cost terms the whole method rests on appear nowhere on the artwork. Panel letters shifted so legacy 3c became 3b, hiding the deletion. | fig3 | BLOCKER |
| 3 | **Fig 5a lost both app image tiles** (the `cam 0 mid` overlay tile and the magnified `cam 4 topR · animal 2 | 16.8 px` tile with solid-detected / dotted-reprojected / red-error segments). Fig 5 no longer shows the signal it claims a proofreader reads, and the bar chart became a line plot across a categorical camera axis. | fig5 | BLOCKER |
| 4 | **Fig 6d is a different analysis from legacy 6d, and its docstring's claim is false against its own data.** It plots miss rate vs animal count as 22.0 → 24.8 → 17.0% (non-monotone, 4-animal cell lowest) while the docstring says "the miss rate rises with animal count too". It also silently drops the 32 single-animal sessions (43 % of the corpus) by reading the `by_animals` table that has no `1` cell. | fig6 | BLOCKER |
| 5 | **Fig 3b plots `C·A³` Hungarian *operations* on a y axis labelled "hypotheses per frame".** The greedy solve evaluates zero hypotheses; at A = 1 the chart says greedy costs 8× more than exhaustive. The 8-camera curve is also clipped off the top of the axis (`ylim` 1e20 vs 7.2e22 at A = 6), so the worst case is a missing marker. | fig3b | BLOCKER |
| 6 | **Every number in the three data tables (1d, 6e, 6f) is set in `GREY = #B3B3B3`** — 2.1 : 1 contrast on white, at 8 pt. Legacy set table bodies in near-black. | fig1d, 6e, 6f | BLOCKER |
| 7 | **Fig 7a's "chance line" contradicts the deposited data's own note.** `fig3_trackers.json caveats` says 1/C is *"a ceiling on what they could achieve, not a level they reach."* The panel labels it `1/C, C = 5` and the docstring calls it "THE CHANCE LINE … below chance". Chance for cross-view identity is governed by animals (A = 2), not cameras. | fig7a | BLOCKER |
| 8 | **Fig 1c shows the same three animals in two palettes inside one panel.** Tile 1 (video) is Okabe-Ito orange/green/blue; tile 2 — the *same camera, same frame, the comparison the panel exists to enable* — is green/magenta/cyan. **Legacy 1c did not have this**: its middle tile matched. This is a regression, not the documented known defect. | fig1c | BLOCKER |
| 9 | **`lint_text.py`'s clipped-text check is dead on arrival**, exactly like the `text_width()` bug the README brags about fixing. PyMuPDF reports off-page span bboxes truncated at the mediabox, so overhang is always ≤ 0.5 pt and the 0.5 pt tolerance never trips. Fig 3e's title lost "of 137,266 frames" and Fig 7d's lost "wins … 4"; the linter reported neither. It has also **lost the type-size floor check** the legacy `lint.py` had. | tooling | BLOCKER |
| 10 | **`assemble.py` has no guard against a row exceeding 180 mm.** `x = (PAGE_W - row_w)/2` goes negative silently. In the 06:24 build Fig 3's middle row was 210.6 mm: panel b's y axis, y label and whole legend were cut off the left edge and panel d's entire twin `cross-view IDF1` axis off the right. The docstring claims "Nothing here can overlap." | tooling | BLOCKER |

---

## Fig 1

### Content lost vs `out/fig1.png`

| Legacy had | New has | Severity |
|---|---|---|
| **1b: per-camera track-label text on every skeleton** (`t89`, `t82`, `t94` on cam 0; `t83`, `t93`, `t95`, `t96` on cam 7) plus **dashed ellipses** grouping them | nothing — no labels, no ellipses | MAJOR |
| **1b: `>` chevron between the before pair and the after pair** | nothing; four tiles read as unrelated | MINOR |
| **1b: `2 of 8 views` note, top right** | gone | MINOR |
| **1b/1c tile badges `cam 0 mid`, `cam 7 sideR`** | `mid`, `sideR` — camera index dropped in 1b while 1c still says `cam 0 mid` | MAJOR (see internal inconsistency) |
| **1c: middle tile in the SAME palette as tile 1** (orange/green/blue) | magenta/green/cyan | BLOCKER |
| **1c: rig tile the same width as the other two, no camera labels** | ~1/4 the area, with eight overlapping ~1.2 pt camera labels, one clipped at the tile edge | MAJOR |
| **1d: `SLEAP` cross-view ID cell = `Maree et al. 2024`** | `–` | *deliberate* — see below |
| **1d: `DANNCE` multi-animal cell = `SDANNCE`** | `✓` | *deliberate* |
| **Bold section titles beside each panel letter** (`Pipeline`, `Cross-view re-identification`, `Triangulated 3D`, `Capability comparison`) | bare `a b c d` | MAJOR |

New content the legacy did not have, correctly: 1a gained the sub-labels row and the
`this work` bracket; 1c gained the `3 animals triangulated from 8 cameras · 45/45 3D
nodes filled` line; 1d gained the Lightning Pose row.

The two 1d cell changes are **deliberate and well argued** in `src/tools_table.py`'s
docstring (a method paper is not a shippable feature; the row is titled
"DANNCE / SDANNCE"). Do not revert them — but see cross-figure #C4.

### Findings

**1.1 `[BLOCKER]` Fig 1c's palette split is a regression, not the documented defect.**
The docstring says "The 3D exports were staged BEFORE `setIdentityPalette()`". True of
tiles 2 and 3, but tile 1 is `after-f150-Camera0_mid.png`, which *is* in the Okabe-Ito
palette. So the panel puts orange/green/blue next to magenta/green/cyan for the same
three animals — and the panel's stated purpose is "tiles 1 and 2 are the SAME scene
from the SAME viewpoint and the reader can compare". Legacy did not have this; verify
by opening `out/fig1.png` and `figures/fig1/fig1c_reconstruction.png` side by side.
Fix is as the docstring says (re-stage), but the docstring must stop describing this
as a whole-panel palette lag when it is a *within-panel* contradiction.

**1.2 `[MAJOR]` "26 per-camera track labels" is the wrong quantity.**
`out/fig1.json ledger` has `detections: 26` and `distinctNames: 22`, with
`collidingNames: [track_89, track_127, track_93]`. There are **22 distinct labels
across 26 detections**. `data/fig1/fig1b_reid_ledger.csv` deposits both columns; the
artwork prints the detection count and calls it a label count.
Verify: `.venv/bin/python -c "import json;print(json.load(open('out/fig1.json'))['ledger'])"`.

**1.3 `[MAJOR]` The 1b docstring mis-describes the 2 unassigned detections.**
It says they are "a partially-occluded animal in Camera3_sideC and Camera7_sideR". But
`ledger.viewsMissingAnIdentity` is `[]` and `assigned = 24 = 3 identities × 8 views`,
so no view is missing an animal — the two unassigned are *extra/ghost* detections.
The docstring's reading and the deposit contradict each other.

**1.4 `[MAJOR]` The rig tile is unreadable.** Eight camera labels at roughly 1.2 pt cap
height (measure: the tile is ~425 px wide in a 4251 px / 180 mm render, the glyphs
~10 px → ~0.42 mm), overlapping each other (`Camera2_topC` over `Camera…`), one
clipped at the right edge, over a bright reference grid the README itself says "floats
above everything". Legacy had no labels and a tile 4× the area. Either crop and drop
the labels (`set3dChrome({labels:false})` now works per the README) or give the tile
its own row.

**1.5 `[MAJOR]` Panel titles were removed with nowhere to go.** `src/style.py` says
"Panel letters, titles and footers are NOT drawn — they are added at assembly time in
Illustrator", and `assemble.py` draws only letters. So the titles are simply lost from
the reproducible artefact. In Fig 1 that costs the reader the ability to tell what
panel c is; in Fig 7 it costs the *distinction between two different quantities both
called within-view IDF1* (see 7.6).

**1.6 `[MAJOR]` A pre-submission warning is printed on the artwork.**
`src/tools_table.py NEEDS_CHECK = True` renders "third-party cells from published
docs, checked 2026-08-04 — re-verify before submission" in salmon under the table.
Correct as a gate; must be cleared, and the README's own note says so.

**1.7 `[MAJOR]` 199.0 × 180 mm with 34.7 % of its horizontal bands completely blank.**
Measured with a 72 dpi rasterisation of `figures/fig1/fig1.pdf`. `fig1a_pipeline.pdf`
is 29.4 % internally blank and `fig1d_tool_table.pdf` 37.9 %, because panels declare a
`ROW_H` larger than their content and `constrained_layout` centres rather than fills.
At 199 mm the figure is 1 mm under `assemble.MAX_H`, leaving ~48 mm for a caption on a
247 mm page — i.e. no margin at all, while a third of the page is white.

**1.8 `[MINOR]` `lint_text.py` reports `ON DATA 'calibration'` and `'re-ID'` in 1a.**
Both are text inside a chevron outline; benign, but they are the reason a reader cannot
distinguish real hits from noise in the linter's output.

---

## Fig 2

### Content lost vs `out/fig2.png`

| Legacy had | New has | Severity |
|---|---|---|
| **Figure footer**: *"a: the app on an 8-camera recording (different rig). b, c: all 50 proofread BMimica sessions, 5 cameras, 2 mice, 15 nodes, 1,277,424 keypoints. Every session enters every panel: 38,322,720 held-out view measurements in c left, 12,774,240 two-anchor solves in c right."* | **nothing.** No panel in Fig 2 carries a provenance line (`grep footnote panels/fig2_*.py` → zero hits) | BLOCKER |
| **2b: `model` label marking the extrapolated region** beyond C = 5 | gone | MAJOR |
| **2d: value labels `12.6` and `2.7` on the extreme pairs**, and the `k / sin θ` curve label | gone; only `k = 1.52 mm / 8/10 within ±25%` | MAJOR |
| **2c: `94.6% ≤ 10 px`** beside the τ = 10 rule | replaced by `99.68% ≤ 20 px`, so the panel draws a rule at 10 px and quotes no value at 10 px | MINOR |
| **2a: numbered step badges + `>` chevrons between steps** | plain numbers, no chevrons | MINOR |
| **2a: tile badges `cam 1 topB` / `cam 6 sideL` / `cam 0 mid` / `cam 2 topC`** | `topB · anchor` etc — camera index dropped | MINOR |
| **2a: wide `magnified` tile** in which solid-vs-dotted overlay is legible | square crop at lower magnification | MINOR |
| **2d: pair names `cam 1+2`, `cam 0+2`** | `1-2`, `0-2` | MINOR (naming, see #C5) |

Correct improvement: `alignment floor` → `comparison floor`, exactly as the README
requires.

### Numbers — all verified correct

Recomputed from `out/fig2.json` with each panel's own aggregation (median across the
50 sessions):

| on artwork | recomputed | verdict |
|---|---|---|
| `median 4.32 px` | 4.3175 | ✓ |
| `60% ≤ 5 px` | 59.898 % | ✓ but rounded to 60 while `captions/fig2.md` and README say **59.9 %** — MINOR inconsistency |
| `99.68% ≤ 20 px` | 99.678 % | ✓ |
| `2.3×` (C = 5) | 75 / 32.4329 = 2.312 | ✓ |
| `k = 1.52 mm` | median(err·sinθ) = 1.5228 | ✓ |
| `8/10 within ±25%`, misses `1-2` and `0-2` | 8; misses exactly `1-2` (13.46°) and `0-2` (18.03°) | ✓ |
| `all 5 views 1.2 — comparison floor` | 1.2163 | ✓ |

### Claims

**2.1 `[BLOCKER]` 2b draws four "measured" markers from one measured quantity.**
`build()` reads `ncam = ps[0]["cameras"] = 5` and computes one correction rate
`p = 1 − median(acc10) = 0.0541`, then plots markers at C = 2, 3, 4, 5 in an identical
style on both curves, inside a band labelled **"p measured, C ≤ 5"**. All 50 BMimica
sessions are 5-camera rigs. `p` was measured at **C = 5 only**, from a 2-anchor solve
with 3 held-out views. The docstring's boast — "an earlier draft drew markers out to
C = 8 and read as eight measured rig sizes when only C ≤ 5 exists in the data" —
applies verbatim to the markers that are still there.
Verify: `.venv/bin/python -c "import json;print({s['cameras'] for s in json.load(open('out/fig2.json'))['per_session']})"` → `{5}`.

**2.2 `[MAJOR]` The `traditional` curve is an assumption drawn like a measurement.**
`traditional = C × NODES` is a modelling premise (that a labeller places every node in
every view). It gets the same 2.0 pt stroke and the same white-ringed markers as the
measured-`p` curve. Nothing on the artwork separates them.

**2.3 `[MAJOR]` The ten points in 2d are not ten observations.**
Every pair carries `n = 1,277,424` — the *same* keypoints, solved ten ways, sharing
five cameras and one calibration. The legacy footer's "12,774,240 two-anchor solves in
c right" made the 10× reuse visible; it is gone. The docstring says so ("the effective
n is well under 10") but the artwork does not, and the `k/sinθ` fit and its ±25 % band
are presented with no interval.

**2.4 `[MAJOR]` "8/10 within ±25%" is an in-sample fit statistic with no null.**
`k` is `median(err·sinθ)` over the same ten points the band is then scored on, so
roughly half are near the curve by construction, and ±25 % is wide against a
2.7–12.6 mm range. It reads on the artwork as a validation. Either state it as
descriptive or fit on a held-out subset (which this design cannot supply).

**2.5 `[MAJOR]` 2b's "model beyond C = 5" caveat is now only in the docstring.**
The docstring asserts "Beyond that the two curves are a MODEL, and the panel says so."
It does not. Legacy's grey `model` label did.

---

## Fig 3

### Content lost vs `out/fig3.png`

| Legacy had | New has | Severity |
|---|---|---|
| **Panel b — "Association cost": the cost-function schematic** (camera, `π(target)`, `detection`, `ray`, `target`) with **both cost equations printed**: `2D wₖ · corr2d · (1 − ‖d − π(t)‖/velThresh) · e^(−λΔt)` and `3D wₖ · corr3d · (1 − dist(t, ray(d))/distThresh)` | **deleted.** Letters shifted; legacy 3c is now 3b | BLOCKER |
| **Panel e: the LUC3D series beside the exhaustive series** | exhaustive only — the comparison is gone from the comparison panel | BLOCKER |
| **Panel e: human-readable time axis** (`1 ms … 10 ms … 1 s … 2 min … 1 h … 1 day`) and the **`10⁷×` ratio annotation** | `10⁰…10⁴ ms`, no ratio | MAJOR |
| **Panel e: the 4a×6c point as an OPEN marker** = extrapolated, with *"○ extrapolated at 347 µs per hypothesis (3a×5c measured); bar = 244–347 µs"* | a pale filled bar of invented height (see 3.2) with no extrapolation caveat | BLOCKER |
| **Panel d: `LUC3D only · both series are this tracker`** | gone | MAJOR |
| **Footer line 1**: *"all 24 (corr2d, corr3d) cells collapse exactly onto r. IDF1 flat from r = 1; switches bottom out at r = 2; shipped r = 6."* | gone | MAJOR |
| **Footer line 2**: *"n = 8 BMimica sessions, fixed 6 000-frame leading window per cell (**not full sessions**), identical across all cells."* | gone | BLOCKER |
| **Footer line 3**: *"d, e: IDF1 and ID-switches via motmetrics on a shared identity-stripped detection pool. c: exact arithmetic. **Exhaustive is our reimplementation** of the published per-frame procedure."* | gone | BLOCKER |
| **Panel c (legacy) axis: log₁₀ hypotheses vs cameras 2–8, series by animals** | axes swapped (animals on x, series by cameras) and cameras only to 8 as series | neutral |
| **Panel c annotation `4a×6c = 1.9×10⁸ ○`** | moved to 3e | neutral |

New content, correctly: 3b gained the greedy curve and the 10⁶ tractability rule; 3c is
now a real measured-runtime panel with the 20 ms budget statement; 3e's title carries
the agreement rate.

### Numbers — all arithmetic verified

`(A!)^C` reproduces every printed hypothesis count: 2a×5c = 32, 2a×6c = 64,
3a×5c = 7,776, 4a×6c = 191,102,976. `agreement_rate = 0.9999854 → 99.999 %` ✓,
`frames_compared = 137,266` ✓. 3c's `worst case 2.4 ms/frame` = 2.4417 ms at
C = 6, A = 4 ✓; `8× under the 20 ms budget at 50 fps` = 20/2.44 = 8.2 ✓. 3d's sweep
collapse onto `r` is real (r = 1 gives 0.9518 / 14 switches from both 0.5/0.5 and 1/1;
r = 0 gives 1,329 switches) ✓.

### Findings

**3.1 `[BLOCKER]` The cost model panel plots two different units on one axis.**
`fig3_02_cost_model.py:50` computes `"greedy": c * a ** 3` and plots it against a
y axis labelled **"hypotheses per frame"**. The greedy solve enumerates *no*
hypotheses. At A = 1 the grey curve sits at 8 while every exhaustive curve sits at 1 —
the chart states that greedy costs 8× more than exhaustive at one animal. The panel's
own docstring forbids exactly this: *"an analytic count and a wall-clock measurement
have different failure modes and must not share an axis."* Two analytic counts of
different things is the same error.

**3.2 `[BLOCKER]` 3e draws a bar with a fabricated height on a quantitative log axis.**
`fig3_05_head_to_head.py:76`: `ax.bar(xi, ms[runnable].max() * 3.0, ...)` → the
`4×6 intractable` bar is drawn at 2,699.5 × 3 = **8,098 ms**, a number that exists
nowhere in the data. A reader reads ~8 s/frame off the axis; the paper's own
extrapolation (191,102,976 hyps × 347 µs) is ~66,000 s/frame, four orders out. Legacy
drew it as an open marker with the extrapolation stated.

**3.3 `[BLOCKER]` The 99.999 % agreement claim is dominated by the easiest configuration
and the artwork says nothing about which frames were excluded.**
From `out/fig3_headtohead.json`: `frames_considered` sums to **198,292**, `frames_clean`
to **137,266** — **30.8 % of frames were skipped** because some camera did not have
exactly `animals` non-null detections, i.e. precisely the occluded frames that are
hardest for association. Of the 137,266 that remain, **122,830 (89.5 %) are the
2 animals × 5 cameras / 32-hypothesis config** and only **161 frames (0.12 %)** test
3 animals. The docstring is honest about all of this; the artwork prints only
"99.999 % of 137,266 frames", and the legacy footer's "198 292 considered" is gone.
The conclusion "The greedy solve … reaches the same answer" generalises from an
almost-entirely-2-animal, occlusion-free sample.

**3.4 `[MAJOR]` The 8-camera curve in 3b is clipped and its worst-case marker is missing.**
`ax.set_ylim(1, 1e20)` but `(6!)^8 = 720^8 = 7.2e22`. The pink curve exits the axis at
A ≈ 5.5 and there is no marker at A = 6. Verify by eye on
`figures/fig3/fig3b_cost_model.png`.

**3.5 `[MAJOR]` "salmon rule: 10⁶ hypotheses/frame" names a colour on the artwork.**
`fig3_02_cost_model.py:94`. A caption that identifies a graphical element by its hue is
unusable to a colourblind reader and reads as internal shorthand. Name the rule, not
its colour.

**3.6 `[MAJOR]` 3d's x axis is a category index presented as a numeric ratio, and most
tick labels are now unlabelled.** In the 06:51 build the ticks read `0 … 1 2 … 6 … 24`
with 0.25, 0.5, 3, 4, 8, 12, 16 dropped, so the reader cannot place the knee. The knee
"at r = 2" and the claim that "the shipped r = 6 sits comfortably past both knees" are
artefacts of which `r` values happened to be sampled and of equal tick spacing.

**3.7 `[MAJOR]` 3c's three series are three different sessions, n = 1 each, with two
undisclosed measurements of the same cell.**
`out/fig3_runtime.json measured`: 2 animals ← `10072022131531`; 3 animals ←
`10072022142111`; 4 animals ← `10072022145420`; plus a **fourth** point at C = 5,
A = 2 from a *different corpus* (`20250827_141755`, BMimica, 1.1243 ms) beside the
SLAP-2M 0.9590 ms. The panel plots both markers at x = 5 with no distinction and runs
its connecting line through one of them. So the animal-count separation confounds
session and corpus, and one cell silently shows two values.
Verify: the two teal markers at `cameras = 5` on `figures/fig3/fig3c_runtime_scaling.png`.

**3.8 `[MAJOR]` 3d does not say the ablation is LUC3D-against-itself.** Legacy printed
"LUC3D only · both series are this tracker". In a figure whose panel e compares LUC3D
against an exhaustive baseline, an unlabelled two-series ablation reads as a
between-method comparison.

**3.9 `[BLOCKER, FIXED 06:49]` Fig 3's middle row overflowed the page.**
At 06:24, `fig3d_sweep.pdf` was 88.0 mm and the row totalled
57.3 + 57.3 + 88.0 + 8 = **210.6 mm**, so `assemble()` placed it at
`x = (180 − 210.6)/2 = −15.3 mm`. Panel b's y axis, y label and its entire four-entry
legend were cut off (`2 cameras` rendered as `eras`), and panel d's whole right-hand
`cross-view IDF1` axis and tick labels were cut off the right edge. Both are visible in
the 06:24 `figures/fig3/fig3.png`. **The guard still does not exist** — add
`assert row_w <= PAGE_W` in `assemble.assemble()`.

**3.10 `[MAJOR]` Fig 3 is 22.6 % blank rows, and its bottom row is a 57.3 mm panel
centred in 180 mm** (122.7 mm unused).

---

## Fig 4

### Content lost vs `out/fig4.png`

| Legacy had | New has | Severity |
|---|---|---|
| **Figure footer**: *"All panels: the same 50 BMimica sessions, 5 cameras, 3 calibrations. c–f 4,253,636 keypoints at stride 60; b 1,277,424 at stride 200. Median lens-distortion displacement 8.4 px (p95 23.4)."* | **nothing. Fig 4 has no provenance on the artwork at all** — `grep footnote panels/fig4_*.py` → zero hits | BLOCKER |
| **Panel titles** (`Triangulation solvers`, `Accuracy vs cameras used`, `Dropping the worst camera`, `Error in an unused camera`, `Per session, both solvers`, `Time per keypoint`) | bare letters | MAJOR |
| **4e: x tick labels `DLT` / `refined` under each group** | none; only the colour key | MAJOR |
| **4e: the `2.35 → 2.15` / `3.33 → 3.14` annotations colour-coded to the solvers** | grey | MINOR |
| **4a: box outlines and coloured left rules separating the three solvers** | three floating columns | MINOR |

New content, correctly: 4a gained an explicit loop arrow; 4b gained "span" on the 3.9×;
4c's `n=` labels are legible again after the 06:49 rebuild.

### Numbers — all verified correct

Recomputed from `out/fig4.json` (and `out/fig2.json` for 4b):

| on artwork | recomputed | verdict |
|---|---|---|
| `4.7 … 1.2`, `3.9× span` | 4.7469 / 1.2163 = 3.903 | ✓ |
| `1.1 / 1.8 / 7.2` | `robust.{clean,mid,outlier}.moved_mm.p50` = 1.0693 / 1.7565 / 7.1815 | ✓ |
| `n=1,167,554 / 3,019,181 / 66,901` | exact | ✓ |
| 4d levels ≈ 3.9 / 3.35 / 3.06 and Δ +0.14 / −0.06 / −0.09 | `heldout_by_views.by_k` p50: k2 3.9193/4.0551, k3 3.3546/3.2947, k4 3.0564/2.9714 | ✓ sign flip real |
| `2.35 → 2.15`, `3.33 → 3.14` | medians of the 50 session dots: 2.3486 / 2.1514 / 3.3349 / 3.1445 | ✓ |
| `refined lower in 50/50 (enforced)`, `34/50` | 50 and 34 | ✓ |
| `6.9×` | 43.7938 / 6.3267 = 6.922 | ✓ |

**4.1 `[MINOR]` The 4f bar labels do not reproduce the printed ratio.** `6` and `44`
give 7.3×, not 6.9×. Print one decimal (`6.3`, `43.8`) or drop the ratio.

### Claims

**4.2 `[BLOCKER]` Panel b is a Fig 2 measurement, from a different sampling, presented
inside Fig 4 with no attribution.** 4b reads `out/fig2.json err3d_mm_by_anchor_count`
(stride 200, 1,277,424 keypoints, DLT-only, aligned to the proofread reference via
RANSAC); 4c–4f read `out/fig4.json` (stride 60, 4,253,636 keypoints, two solvers). The
figure's *headline* panel is therefore not from the run the rest of the figure is from,
and the README's own instruction — *"this makes Fig 4d a BMimica panel inside an
otherwise single-session figure — the provenance mix must be flagged on the artwork"* —
is unmet in the strongest possible way, because the footer that used to carry it is
gone.

**4.3 `[MAJOR]` 4b's band is unlabelled and is not an interval on the plotted median.**
The docstring: "Each session contributes its own p25/p50/p75 and this panel plots the
ACROSS-SESSION median of each". A median-of-IQRs is not a confidence interval and not
that session's IQR either. Nothing on the artwork names it.

**4.4 `[MAJOR]` 4c measures displacement and is framed as accuracy, while the quantity
that would justify the framing is deposited and unplotted.**
`out/fig4.json robust.{clean,mid,outlier}.improved_frac` = **0.868 / 0.834 / 0.960** —
the fraction of keypoints where dropping the camera actually *lowered* the kept-view
error. The panel plots only "the 3D point moves (mm)", which is agnostic about
direction, and the docstring reads it as a quality claim ("an order of magnitude more
than any solver choice does"). Plot `improved_frac`, or restrict the claim to movement.

**4.5 `[MAJOR]` The 7.2 mm headline is 1.57 % of the data and the artwork does not say so.**
66,901 / 4,253,636 = 1.573 %. `n=66,901` is printed but the share is not, and the three
boxes are drawn at identical width despite n differing 45-fold — which is precisely the
failure the docstring says printing n was meant to prevent ("three boxes of visibly
different weight must not read as three equal conditions").

**4.6 `[MAJOR]` 4d's difference strip gives maximum visual prominence to an effect the
docstring calls negligible, with no interval.** The Δ axis is ±0.1 px and the bars fill
it; the underlying differences are 0.06–0.14 px on a 3–4 px level. The strip pools
1,417,879 keypoints from 50 correlated sessions as one sample and shows no
session-level spread, while panel e (correctly) treats the session as the unit. The
deposited `per_session[].heldout_ba_better_frac` would give a session-level version.

**4.7 `[MINOR]` `worse_than_dlt.ba = 0 / 4,253,636` is the enforced tautology and is
correctly kept off the artwork**; the `guard.returned_seed = 0 of 4,253,636` note in
the JSON is the contingent quantity and is also off the artwork. 4e's `(enforced)`
label is the right disclosure. No action beyond keeping it.

---

## Fig 5

### Content lost vs `out/fig5.png`

| Legacy had | New has | Severity |
|---|---|---|
| **5a: image tile `cam 0 mid`** with the app's overlays on all three animals | gone | BLOCKER |
| **5a: image tile `cam 4 topR · animal 2 \| 16.8 px`**, magnified, showing **solid = detected, dotted = reprojected, red = the error** as drawn segments | gone | BLOCKER |
| **5a: the footer decoding the overlay** (`solid = detected · dotted = reprojected from the 3D · red = the error`) | gone | BLOCKER |
| **5a: grouped BAR chart** over 8 cameras × 3 animals | a **line plot** connecting eight categorical camera names | MAJOR |
| **Figure footer**: *"Different corpora: a is one frame of an 8-camera recording in LUC3D, 3D solved from all 8 views (the app's normal state, not a held-out or anchored solve); c and d are 74 SLAP-2M sessions, 1,561,915 keypoints. The ranking in c and d is a property of the residual, measured offline: LUC3D reports the residual for the frame you are on and **has no ranked worklist, sort or filter**."* | gone | BLOCKER |
| **5c: the `random` diagonal's value `10` at the 10 % budget** | gone (32 / 27 / 12 remain) | MINOR |
| **5c: `oracle` drawn as a solid grey line labelled on the curve** | dashed salmon with an "(ceiling)" key entry — an improvement | — |

New content, correctly: 5a gained per-animal mean labels; 5c gained
"mean over 74 SLAP-2M sessions"; 5d gained "residual wins in 74/74"; 5b's bracket now
spans three stages, matching its docstring.

### Numbers — all verified correct

`out/fig5a.json reprojErrorsAllViews`: means 3.27 / 3.19 / 12.1 → printed 3.3 / 3.2 /
12.1 ✓. `out/fig6_detections.json`, mean over 74 sessions at the 10 % budget: residual
26.95 → `27` ✓, confidence 11.72 → `12` ✓, oracle 31.82 → `32` ✓. Residual > confidence
in 74/74 ✓ (`data/fig5/fig5d_per_session.csv` reproduces both columns).

### Findings

**5.1 `[BLOCKER]` Deleting both 5a tiles removes the only evidence in the figure.**
Fig 5 is about a signal a human reads off the screen; the legacy panel showed that
screen. Its replacement is a line plot of the same three numbers. The tiles come from
`out/fig5a-f150-*.png`, which still exist. Note that `fig5_panel_a.mjs` was written
*specifically* to stage these tiles from an all-views solve (README: "Exists because
Fig 5a used to reuse Fig 2's two-anchor frame"), so the driver's whole purpose is now
unused for its images.

**5.2 `[MAJOR]` A line plot over a categorical camera axis.** Connecting `mid → topB →
topC → sideC → topR → topL → sideL → sideR` implies ordering and interpolation between
cameras that do not exist; the visual "dip at topL" for animal 2 is an artefact of
camera ordering in the manifest. Legacy's grouped bars were the right mark.

**5.3 `[MAJOR]` The "no ranked worklist" caveat exists only in a docstring now.**
`fig5_01_loop.py` argues at length that drawing a "rank" box would claim a feature that
does not exist — and then panels c and d measure exactly such a ranking. The legacy
footer said so on the page. Nothing does now.

**5.4 `[MAJOR]` 5c/5d's circularity is reduced, not removed, and the residual amount is
deposited and undisclosed.** The ranking signal and the payload target are both
distances involving a reprojected 3D reconstruction:
`out/fig6_detections.json caveats` — *"The reference is the proofread 3D reprojected
into each camera"* — and `sessions[].spearman` records **ρ(signal, target) = 0.667 –
0.735** per difficulty stratum. That correlation *is* the mechanism by which the
residual "finds" 85 % of the oracle's capture; it is the single most informative number
for judging the panel and appears neither on the artwork nor in the docstring.

**5.5 `[MAJOR]` The confidence baseline is essentially the null.** At a 10 % budget,
confidence captures 11.72 % against random's 10 %. Beating a near-null and calling it
"the obvious alternative" overstates the contrast; the oracle ratio (27/32 = 85 %) is
the defensible framing and should lead.

**5.6 `[MAJOR]` 5c/5d presuppose correct association, undisclosed.**
`caveats`: *"The triage analysis takes cross-view identity from that reference match,
i.e. it assumes association is already correct."* Fig 5's result therefore conditions on
Fig 3's problem being solved perfectly. Not stated anywhere on Fig 5.

**5.7 `[MAJOR]` 5d wastes 8/9 of its area.** Axes run 0–45 on both axes while the data
occupy x ∈ [9, 17], y ∈ [21, 45]. Legacy used 0–20 × 0–50. The `equal` diagonal does
not need the full square to be legible — clip to the data and draw the diagonal across
whatever range remains.

**5.8 `[MINOR]` `figures/fig5/fig5b_capture.pdf` and `.png` are orphans** — 57.3 mm
wide, no generator emits them (`fig5_03_capture.py` saves `5c`). They are committed and
they collide by letter with `fig5b_loop`. Delete.

**5.9 `[MINOR]` `fig5_02_per_view_error.py`'s docstring says "Fig 5b"** while it saves
`5a`; `fig5_01_loop.py` also says "Fig 5b". Two panels claim the same letter.

**5.10 `[MINOR]` 27.2 % blank rows; `fig5b_loop.pdf` is 40.1 % internally blank.**

---

## Fig 6

### Content lost vs `out/fig6.png`

| Legacy had | New has | Severity |
|---|---|---|
| **6b: `50 mm` scale bars burned into all six tiles** (`legacy/fig6.py:103 scale_bar()`) | none. **No image panel anywhere in the new set carries a scale bar** except `fig6s2`'s `20 mm` | BLOCKER |
| **6b: tiles cropped to the app-recorded animal bboxes** | uncropped 1280×1024 frames at ~26 mm wide, so each mouse is ~4 mm and ~60 % of every tile is black cage wall | MAJOR |
| **6a: an inset box magnifying the animals, badge `4 in 3D`, with a leader line** (`legacy/fig6.py:189–217`, from `threeD.animalsBBox` / `animalsScreen`) | nothing; the animals are an unreadable blob | MAJOR |
| **6a: `6 proofread` badge** | gone | MINOR |
| **6c: error bars on all three sub-plots** and the `mean ± s.d.` label | none, although `err_mean_sd` and `miss_rate_sd` are deposited per stratum | MAJOR |
| **6c right: bar chart with a value label on every bar** (0.3 … 1.8) | unlabelled line | MINOR |
| **6d: two series (`1 animal`, `2 animals`) vs difficulty, with an open marker for the n = 1 cell** — the actual difficulty × animal-count control | one series of miss rate vs animal count, 1-animal cell dropped | BLOCKER |
| **6e: `Nodes` column (15)** | gone | MINOR |
| **6e: `Measured in c, d, f` column** (`–` for BMimica, `✓` for SLAP-2M) — the disclosure that c/d/f are SLAP-2M only | gone | BLOCKER |
| **6e: `8 (6 proofread)` for SLAP-2M cameras** | `8` | BLOCKER (see 6.4) |
| **6e: `Total 130 of 140`** | `total 130` | MINOR |
| **6f: `Animals` column** (1 / 1,2 / 1,3 / 1,2,4 / 1,2 / 1,2 / 2,3) | gone | MAJOR |
| **6f: `Bedding (b/w)` column** (12/0, 8/5, 4/5, 6/7, 6/4, 1/3, 7/6) | gone | MAJOR |
| **6f: `Error p99 (px)` column** | gone (caption still quotes it — see 6.6) | MAJOR |
| **6f: `Error mean (px)`** | `Error p50 (px)` — different statistic, different numbers | MAJOR |
| **Figure footer**: *"c, d, f: 74 SLAP-2M sessions, 1,561,915 keypoints, raw detections from the benchmark's **shared identity-stripped pool**, matched per frame against the proofread 3D reprojected into each camera. a, b: one SLAP-2M session (difficulty 4, 4 animals, black bedding)."* | only "one frame, six cameras · SLAP-2M" under panel b | BLOCKER |

### Numbers — verified, with one that moved

All of `data/fig6/*` and panel 6e/6f reproduce `out/fig6.json` and
`out/fig6_detections.json by_difficulty` exactly (sessions 12/13/9/13/10/4/13;
keypoints 252,265 → 126,890; missing 5.3 → 57.9 %; p50 2.89 → 3.19; p95 9.00 → 12.60;
>20 px 0.34 → 1.83). Corpora: 10,084,734 + 1,954,440 = 12,039,174 ✓; 18.66 + 10.86 =
29.52 → 29.5 ✓; 56 + 74 = 130 ✓. Mean pose nose-to-trunk 64.505 mm ✓.

| on artwork | recomputed | verdict |
|---|---|---|
| `10.90×` | 0.5790/0.05313 = 10.898 | ✓ |
| `1.11×` | p50 3.1929/2.8893 = 1.1051 | ✓ **but this is the p50 ratio; legacy printed `1.29×`, the MEAN ratio (4.7248/3.6660 = 1.2888). `CAPTIONS.md:611` and `captions/fig6.md:6` still say "rises 1.29-fold (3.67 → 4.72 px)".** BLOCKER caption/artwork mismatch |
| `5.34×` | 0.018284/0.003422 = 5.3436 | ✓ (legacy printed `5.3×`; `captions/fig6.md:77` says 5.3×) |
| 6d: 22.0 / 24.8 / 17.0, n = 35 / 4 / 3 | `out/fig6_difficulty.json by_animals` miss_rate 0.21953 / 0.24729 / 0.16959 | ✓ arithmetic, wrong table — see 6.1 |

### Findings

**6.1 `[BLOCKER]` 6d's docstring claim is contradicted by 6d's own data, and the panel
reads the wrong `by_animals` table.**
The docstring: *"the miss rate rises with animal count too, so the two are not separable
here and panel c must NOT be read as a pure difficulty effect."* The plotted values are
**22.0 → 24.8 → 17.0 %** — non-monotone, and the 4-animal cell is the *lowest* of the
three. Nothing supports "rises".
Worse, the panel reads `out/fig6_difficulty.json by_animals`, which has cells for
`2, 3, 4` only, so the **32 single-animal sessions — 43 % of the 74-session corpus —
are silently absent**. `out/fig6_detections.json by_animals` *does* have a `1` cell
(n = 32, miss 12.40 %) and reports the 2-animal miss rate as **33.19 %**, not 22.0 %.
So two deposited tables give the same quantity 50 % apart and the artwork uses the one
that omits the largest stratum.
Verify:
```bash
.venv/bin/python -c "
import json
print({k:(v['n_sessions'],round(v['miss_rate'],4)) for k,v in json.load(open('out/fig6_difficulty.json'))['by_animals'].items()})
print({k:(v['n_sessions'],round(v['miss_rate'],4)) for k,v in json.load(open('out/fig6_detections.json'))['by_animals'].items()})"
```
The legacy panel — miss rate vs *difficulty*, split *by* animal count — was the control
this figure needs and it is gone.

**6.2 `[BLOCKER]` Panels 6a and 6b ignore the crop, inset and scale metadata that
`fig6_app.mjs` deposits for exactly this purpose.** `out/fig6-app.json` carries
`scale.L = 50` plus `scale.perView.<cam>` (the px-per-mm needed for the 50 mm bar),
`views[].bbox` (per-view animal boxes), and `threeD.rigBBox` /
`threeD.animalsBBox` / `threeD.animalsScreen` (for 6a's crop, inset and leader). Both
panels call `tile(ax, p, None, ...)` — bbox `None`, i.e. the whole uncropped export.
The legacy generator used all of it. This is a mechanical regression with the fix
already sitting in the manifest.

**6.3 `[BLOCKER]` Every number in tables 6e and 6f is `#B3B3B3`.** `fig6_04_corpus.py:99`
and `fig6_08_difficulty_strata.py:65` set body cells to `GREY` (`= SET2[7] = #B3B3B3`),
which is **2.1 : 1** against white. The headers are `INK` (8.6 : 1). The result is a
table whose labels are readable and whose data is not.

**6.4 `[BLOCKER]` 6e asserts an 8-camera SLAP-2M corpus while every SLAP-2M measurement
in the paper uses 6 cameras.** `fig6.json corpora[1].cameras_range = [8]`, so the table
prints 8. But 6b shows six tiles; `fig3_runtime.json blocked` states the shared
detection pool covers only 6 cameras (`back/backL/mid/midL/top/topL`) and that C = 7, 8
are *not measured*; legacy Fig 7c's footer said "74 sessions × 6 cameras"; and Fig 7's
caveats compute the cross-view bound at "0.167 at C=6". Legacy's `8 (6 proofread)`
disclosed the gap in one cell. Restore that qualifier.

**6.5 `[MAJOR]` 6c's error bars were removed although the spread is deposited.**
`out/fig6_detections.json by_difficulty[*].{err_mean_sd, miss_rate_sd}` exist for all
seven strata. The strata are n = 4 to 13 and the panel now shows seven bare points, so
the difficulty-6 cell (n = 4, miss 46.0 %) is drawn with the same authority as the
n = 13 cells.

**6.6 `[MAJOR]` The main-figure 6c prints no n per stratum; only the supplementary does.**
`fig6_03_difficulty.py` (which saves `fig6s3`, not in the composite) has
`footnote(ax, "n = " + …)`; `fig6_06_detection_quality.py` (the real 6c) has no
footnote at all. So the requirement "n per stratum is printed because the strata are
far from balanced" is met only by a panel that is not in the figure.

**6.7 `[MAJOR]` `captions/` and `CAPTIONS.md` describe a Fig 6 that no longer exists.**
`captions/fig6.md:6` — *"rises 1.29-fold (3.67 → 4.72 px)"* — against the artwork's
`1.11×`; `captions/fig6.md:77` quotes *"the 99th 1.88×"* and *"the 95th percentile
1.40×"* from a p99 column the table no longer has.

**6.8 `[MAJOR]` 6d's legend describes a condition that does not occur.**
`hollow = n = 1 session` is printed while n = 35, 4, 3 and no marker is hollow.

**6.9 `[MAJOR]` The difficulty range is stated three different ways.**
Deposited data: difficulty **1–7**, n = 12/13/9/13/10/4/13 over 74 sessions.
`fig6_06`'s docstring says "1-7" ✓. `fig6_03`'s docstring says **"2-7 rating"** and
"13 sessions at difficulty 7, 10 each at 2 and 4" — the data has 13 at 2 and 13 at 4.
`README.md:396-399` says **"42 SLAP-2M sessions with difficulty 2–7 (13 at 7, 10 each
at 2 and 4)"** and **"bedding (black 23 / white 19)"**, against the deposit's 74
sessions and black 44 / white 30. The README's Fig 6 block is stale.

**6.10 `[MAJOR]` 6b's tile badges collide with the tile edges.** In the 06:51 build the
`backL`, `top` and `topL` badges sit over the top boundary of their tiles. `tile()`
places badges at 0.97 in axes coordinates, which lands on the image edge when the tile
is this small.

**6.11 `[MINOR]` Docstring letters do not match the letters the scripts emit.**
`fig6_02_pose.py` says "Fig 6b" → saves `6s2`. `fig6_03_difficulty.py` says "Fig 6c" →
saves `6s3`, and cross-references "Fig 7b" where it means 7e. `fig6_04_corpus.py` says
"Fig 6d" → saves `6e`. Three panels claim letters that belong to other panels; any
caption written from a docstring will cite the wrong panel.

**6.12 `[MINOR]` 198.8 mm tall with 31.6 % blank rows.** `fig6e_corpora.pdf` is 50.9 %
internally blank and `fig6f_difficulty_strata.pdf` 48.3 %.

---

## Fig 7

### Content lost vs `out/fig7.png`

| Legacy had | New has | Severity |
|---|---|---|
| **Figure footer**: *"Identical identity-stripped detections for every tracker shown. Session-level statistics throughout; **SHIPPED LUC3D configuration** (see caption, Provenance)."* | gone. The README calls this one of "the two headline integrity items"; the artwork no longer states which of three co-located runs it is | BLOCKER |
| **7a: 95 % CI whiskers**, and the footer *"mean ± 95% CI"* | no interval, although `ci95_lo/hi` are deposited for all four trackers | MAJOR |
| **7a: second footer** *"LUC3D drift ≤ 0.007 in every session; ahead of every other tracker in 50/50"* | gone (`drift_abs_max = 0.006991` is deposited) | MAJOR |
| **7a: `50 full BMimica sessions`** | `50 BMimica sessions` — "full" distinguished these from Fig 3d's 6,000-frame windows | MINOR |
| **7c: footer `one step per session; n = 74 sessions × 6 cameras, session mean IDF1`** | gone | BLOCKER |
| **7c: footer `LUC3D 229 · SLEAP 173 · ByteTrack 4 · tied 38 of 444 camera-sessions best`** | gone (`camera_session_argmax` is deposited) | MAJOR |
| **7c: the 0.2 / 0.3 / 0.5 / 0.7 threshold markers** | only 0.9 | MINOR |
| **7e: exact counts `34 240 / 62 320 / 51 049 / 3 710 / 3 608 / 12 305`** | `34.2k / 62.3k / 51.0k / 3.7k / 3.6k / 12.3k` — the docstring's own point that "SLEAP'S SWITCH COUNT IS ESSENTIALLY LUC3D'S (3,608 vs 3,710)" is unreadable, and so is the 3.3× ByteTrack ratio | MAJOR |
| **7f: footer `R² = 0.95 for LUC3D`** | gone | MINOR |
| **Panel titles** (all six) | bare letters | MAJOR |

### Numbers — all verified correct

From `out/fig3_trackers.json`:

| on artwork | recomputed | verdict |
|---|---|---|
| 7a: `0.749 → 0.749 ×1.00`, `0.115 → 0.062 ×0.53`, `0.157 → 0.046 ×0.29`, `0.011 → 0.011 ×1.00` | 0.74938/0.74925 = 0.9997; 0.11540/0.06156 = 0.5334; 0.15736/0.04568 = 0.2903; 1.0001 | ✓ |
| 7b: `Δ0.012 / Δ0.079 / Δ0.148`, recall `Δ0.004` | 0.74075−0.72913 = 0.0116; 0.69351−0.61429 = 0.0792; 0.58750−0.43923 = 0.1483; 0.73000−0.72621 = 0.0038 | ✓ |
| 7c: `36/74 · 22/74 · 10/74` | `survival_n_sessions["0.9"]` = 36 / 22 / 10 | ✓ |
| 7d: `+0.141 (25/32)`, `+0.035 (23/35)`, `−0.030 (0/4)`, `−0.028 (0/3)`, pooled `+0.075 [+0.049,+0.102] 48/74 P = 0.014` | exact | ✓ |
| 7e: 34,240 / 62,320 / 51,049 / 3,710 / 3,608 / 12,305; 15,947,278; `98.8%–99.3%` | exact; fn_share 0.98817–0.99333 | ✓ |
| 7f: `r = 0.975 / 0.949` | 0.97467 / 0.94934 | ✓ |

### Findings

**7.1 `[BLOCKER]` The chance line contradicts the deposit's own interpretation.**
`out/fig3_trackers.json caveats`: *"Cross-view IDF1 is bounded near 1/C for any tracker
with no cross-view association mechanism (0.20 at C=5, 0.167 at C=6). At C=5 the
per-camera trackers land far **BELOW** that bound … so the bound is **a ceiling on what
they could achieve, not a level they reach**."* The panel draws it as a dashed rule
labelled `1/C, C = 5` and the docstring reads it as *"THE CHANCE LINE … every
per-camera tracker's CROSS-view score sits BELOW chance, which is the point"*. A
ceiling and a chance level are different claims, and chance for cross-view identity is
set by the number of *animals* (A = 2 here → ~0.5 for a coin-flip cross-view
assignment), not by C. The conclusion survives under either reading, but the label and
the docstring must be rewritten to say "ceiling for a tracker with no cross-view
mechanism".

**7.2 `[BLOCKER]` A measured LUC3D disadvantage the deposit says must be stated appears
nowhere.** `caveats`: *"LUC3D fragments MORE than SLEAP (+24.0 fragmentations per camera
per session, 95 % CI [+18.3, +30.0]). **Stated, not hidden.**"*
`slap2m.fragmentations_paired` is deposited. No panel in the set plots or mentions it.

**7.3 `[BLOCKER]` The figure's headline paired advantage is carried by the stratum where
the claimed mechanism cannot apply.** 7d's pooled `+0.075` over 74 sessions is
dominated by the 1-animal cell (`+0.141`, n = 32 = 43 % of the corpus, 25/32 wins).
With one animal there is nothing to associate, so a +0.141 IDF1 gap there cannot be a
cross-view-association result — it is a detection-gating / gap-handling difference.
Meanwhile the two genuinely multi-animal cells, where the mechanism should help most,
are **negative (0/4 and 0/3)**. The panel prints all of this honestly; the docstring
weights the negative cells down for small n while weighting the 1-animal cell up
without comment. Split the pooled statistic, or drop the 1-animal cell from it.

**7.4 `[MAJOR]` 7b is a between-session comparison drawn as a within-session slope.**
`by_bedding` is black n = 44 vs white n = 30 — different sessions, not the same sessions
under two beddings. Connecting the two conditions with a line for each tracker reads as
a repeated measure. The detector-recall control (Δ0.004) rules out a recall confound
only; difficulty, animal count and coat colour all still differ between the two
groups, and there are no intervals. Either draw it as two grouped points with CIs, or
match on difficulty.

**7.5 `[MAJOR]` 7f omits the one tracker that contradicts the panel's claim.**
`detector_recall_corr` deposits `bytetrack: r = 0.780, R² = 0.608`. ByteTrack is in 7b,
7c and 7e but is dropped from 7f, and it is exactly the counter-example to "the level is
set by detection". Plot it or say why not.

**7.6 `[MAJOR]` Two different quantities called "within-view IDF1" sit in one figure with
nothing to distinguish them.** 7a's `within view` = **0.749** (BMimica, 50 sessions,
C = 5); 7c's survival curve = SLAP-2M within-view IDF1, whose mean is **0.736** and
median **0.900** (74 sessions, C = 6). The legacy panel titles
(`Within- vs cross-view IDF1` / `Within-view IDF1 per session`) and 7c's footer carried
that distinction; both are gone, and 7c/7d/7e now carry no corpus label at all.
The deposit's own caveat — *"Corpus means are dragged by a heavy tail: LUC3D within-view
IDF1 mean 0.736 vs median 0.900. **Report both.**"* — is honoured nowhere.

**7.7 `[MAJOR, FIXED 06:49]` 7f's colour key painted SLEAP's r in LUC3D's colour.**
The 06:24 build drew both r values in one teal `ax.text`, while SLEAP's points are
periwinkle. Fixed in the current build (`text_legend` with per-entry colours). Kept
because it is the class of defect no text linter can see and the only detection route
is reading the panel.

**7.8 `[MAJOR, FIXED 06:49]` 7c's tracker names overprinted the y axis and the curves.**
`lint_text.py` on the 06:24 build: `OVERLAP '100' × 'SLEAP' (22%)`,
`OVERLAP '100' × 'ByteTrack' (21%)`, `ON DATA 'ByteTrack' (29%)`. This was a *re-*
regression: `README.md:613-615` records that the names had already been moved to a
lower-left key for precisely this reason.

**7.9 `[MAJOR, FIXED 06:49]` 7d's pooled statistic was clipped off the page.**
The rendered string was `… 48/74, sign test P = 0.01` with bbox x1 = 249.6 pt on a
249.4 pt page — the trailing `4` of `P = 0.014` and the word `wins` were outside the
mediabox. `lint_text.py` did not report it (see 9.1).

**7.10 `[MINOR]` 3D-MuPPET appears in 7a and in no other panel.** Four trackers in a, three
in b/c/e, two in d/f. A reader cannot tell whether the omissions are deliberate.

**7.11 `[MINOR]` Tracker naming drifts within the figure**: `SLEAP per-camera` in a,
`SLEAP` in c/d/e/f.

---

## Cross-figure

**C1 `[BLOCKER]` No figure carries a figure-level footer, because nothing draws one.**
`src/style.py`'s house rule sends titles and footers to "assembly time in Illustrator";
`assemble.py` draws only panel letters. Net effect across the set: every legacy footer
is gone and the surviving provenance is whatever individual panels happen to put in a
`footnote()`. Coverage today (`grep -n "footnote(\|fig.text(" panels/*.py`):

| figure | provenance on the artwork |
|---|---|
| 1 | the 1b ledger line and the 1c node-count line only |
| 2 | **none** |
| 3 | `r = 0: no 3D term`, `salmon rule: 10⁶ …`, `hypotheses/frame above each bar`, and 3e's agreement title |
| 4 | **none** |
| 5 | 5a `one frame (150), 8 cameras, all-views solve`; 5c `mean over 74 SLAP-2M sessions` |
| 6 | 6b `one frame, six cameras · SLAP-2M` only |
| 7 | 7a, 7b, 7e, 7f footnotes; **7c and 7d have no corpus label** |

Figures 2, 4 and 6 need a footer mechanism (`assemble.py` could take an optional
per-figure footer string, which is the smallest fix) before this set is submittable.

**C2 `[BLOCKER]` `GREY = #B3B3B3` is used for load-bearing text.** It is `SET2[7]`, a
*categorical series* colour repurposed as a text ink. Contrast on white: **2.10 : 1**
(vs `INK = #4C4D4C` at 8.6 : 1). It carries: every cell of tables 1d, 6e and 6f; the
`n=` labels in 4c; the `random` label in 5c; the `hollow = n = 1 session` note in 6d;
6b's provenance line; 3b's tick and rule labels. Introduce a separate `MUTED` ink
around `#6E6E6E` (4.6 : 1) and keep `GREY` for series.

**C3 `[BLOCKER]` Colour semantics rotate across figures with no cross-figure key.**
The same three Set2 hues carry unrelated meanings on facing pages:

| hue | fig 3 | fig 4 | fig 5 | fig 6 | fig 7 |
|---|---|---|---|---|---|
| teal `#66C2A5` | greedy / LUC3D | refined | cross-view residual | beyond 20 px | LUC3D |
| salmon `#FC8D62` | exhaustive | — | oracle (ceiling) | keypoints missing | ByteTrack |
| periwinkle `#8DA0CB` | 6 cameras | **DLT** | detector confidence | error when present | **SLEAP** |
| pink `#E78AC3` | 8 cameras | 3D error vs proofread | — | (in 6b's overlays) | 3D-MuPPET |

Teal ≈ "ours" is at least consistent. Periwinkle meaning DLT in Fig 4 and SLEAP in
Fig 7, and salmon meaning "exhaustive baseline" in 3 but "oracle ceiling" in 5 and
"missing keypoints" in 6, is not. Reserve at least one hue per recurring entity
(LUC3D, SLEAP, ByteTrack, DLT, refined) across the whole set.

**C4 `[MAJOR]` Fig 1d says SLEAP has no cross-view ID; Fig 3 compares against a method
whose title ends "…in SLEAP".** The Fig 1d cell change is correct and well argued in
`src/tools_table.py` (a method paper is not a shippable feature). But Fig 3a/3b credit
"Maree et al. 2024" for the exhaustive method, and that paper is *Multi-view
triangulation-enabled annotation for multi-animal 3D pose **in SLEAP***. One sentence in
the Fig 1d caption must reconcile them, or a reviewer will read Fig 1d as contradicting
Fig 3.

**C5 `[MAJOR]` Camera and pair naming is inconsistent across and within figures.**
- `cam 0 mid` (fig1c) vs `mid` (fig1b, fig5a) vs `Camera0_mid` (fig1c's rig raster) vs `0 mid` (legacy fig5a).
- Camera-pair names: `cam 1+2` (legacy) → `1-2` (fig2d).
- Config labels: `2a×5c` (legacy fig3) → `2×5` (fig3e) with the meaning moved to an axis label.
Pick one convention and apply it. Dropping the camera index from fig1b while keeping it
in fig1c means the two panels of the same frame appear to show different cameras.

**C6 `[MAJOR]` Cross-figure numeric consistency is good, with two exceptions.**
Every number I could recompute matched its deposit — the 4.32 / 99.68 / 2.3× / 1.52 /
8-of-10 / 3.9× / 7.2 / 6.9× / 0.749 / 0.012 / 36-22-10 / +0.141 / 0.975 chain all
verify, and `reference_reproj_px.p50 = 2.4062` matches the "2.41 px median" the README
standardised on. The exceptions:
- **`1.29×` vs `1.11×`** for the same Fig 6c quantity (mean-ratio vs p50-ratio). `CAPTIONS.md:611` and `captions/fig6.md:6,77` still carry the mean version and its `3.67 → 4.72 px` values, which appear nowhere on the artwork.
- **`59.9%` vs `60%`** for Fig 2c's ≤ 5 px accuracy (`captions/fig2.md:58` vs the artwork).
No genuinely *stale-run* value survived: the 12-session Fig 2 figures (2.15 px,
4.12/2.63/1.83/1.24 mm, 0.149/0.142), the single-session Fig 4 figures (1.679/1.577,
1.88 px, 39 %, 7.1 px, 4.6 px) and the 35 % regression rate are all absent from the
artwork. `README.md:498-499` correctly records them as superseded.

**C7 `[MAJOR]` No scale bar anywhere in the set except `fig6s2`.** Legacy Fig 6b had
50 mm bars on all six tiles. For a paper whose results are quoted in millimetres
(4.75 mm, 7.2 mm, 1.22 mm, 64.5 mm nose-to-trunk), no image panel gives the reader a
spatial referent. The px-per-mm needed is deposited in `out/fig6-app.json scale.perView`.

**C8 `[MAJOR]` Composites are stale relative to panels, and the build does not detect it.**
At 06:27 the panel PDFs and the composites were mutually consistent; between 06:38 and
06:40 five panel sources were edited; at 06:49 a rebuild landed. During that window
`figures/figN/figN.pdf` embedded superseded panel content — including the clipped Fig 3
row and the miscoloured Fig 7f key — while every file was present and looked complete.
Both `figures/` and `data/` are committed, so this state is reachable from a fresh
clone. Add an mtime check to `make_figures.py`, or make `assemble` unconditional.

**C9 `[MAJOR]` Composite pages are 19–35 % blank while two of them sit on the 200 mm
ceiling.** Measured on a 72 dpi rasterisation, fraction of scanlines with no ink:
fig1 34.7 %, fig6 31.6 %, fig5 27.2 %, fig3 22.6 %, fig4 22.6 %, fig7 19.3 %, fig2 18.6 %.
fig1 is 199.0 mm and fig6 198.8 mm against `MAX_H = 200`. Cause: panels declare a
`ROW_H` larger than their content and `constrained_layout` centres rather than fills, so
`fig6e_corpora` is 50.9 % internally blank, `fig6f` 48.3 %, `fig5b_loop` 40.1 %,
`fig1d` 37.9 %, `fig1a` 29.4 %. Two short rows compound it (fig3's row 2 uses 57.3 of
180 mm; fig5's row 0 uses 88 of 180). Tighten `ROW_H` per panel and the two figures at
the ceiling come down 30–40 mm with no loss.

**C10 `[BLOCKER]` `lint_text.py` cannot see the two defect classes it exists to catch.**
- **Clipped text is undetectable.** `check()` flags a span only if `r1.x1 > page_r.x1 + 0.5`, but PyMuPDF reports off-page span bboxes *truncated at the mediabox*, so overhang is always ≤ 0.5 pt. Demonstrated: `fig3e_head_to_head.pdf`'s title span is `'same grouping as LUC3D on 99.999% '` with bbox x1 = 162.99 on a 162.52 pt page — the string in the source is `…of 137,266 frames` and the linter reported nothing. Same for `fig7d_by_animals.pdf` (x1 = 249.6 / 249.4). This is the identical failure mode as the legacy `text_width()` bug the README documents. Fix by comparing the *source string's* measured advance width against the axes extent, or by rasterising and looking for ink at the trim edge; and add a positive control that must fail.
- **The type-size floor is gone.** Legacy `lint.py` enforced Nature's 5 pt minimum (README: "50 runs in Fig 5 alone, at 4.6 pt"). `lint_text.py` reads `s["size"]` into `spans()` and never tests it. Current sub-6 pt type: `fig3a_association.pdf` has a **4.55 pt** `'C'` (below the 5 pt floor); `fig3b`, `fig3d` and `fig3e` carry 5.6 pt log-minor tick labels.
- Two lesser issues: `_is_badge()` is defined and never called (dead code, and `spans()` already filters white text); and the composites `figN.pdf` are never linted, so a panel letter colliding with panel content would not be seen.

**C11 `[MINOR]` `.venv/bin/python lint_text.py` reported 31 issues at 06:24 and 0 at
06:51.** The 06:24 set is worth keeping as the regression baseline: fig1a ×2, fig1b ×2,
fig2b ×4, fig3b ×4, fig4b ×2, fig5c ×2, fig6e ×2, fig6s2 ×1, fig6s3 ×5, fig7c ×4,
fig7d ×2, fig7f ×1. Every one was a text-on-data or text-on-text hit in a *panel*; none
of the composite-level or clipped-text problems above appeared in it.

**C12 `[MINOR]` Orphan and duplicate outputs are committed.**
`figures/fig5/fig5b_capture.{pdf,png}` has no generator and collides by letter with
`fig5b_loop`. Six panel docstrings claim letters that differ from what they emit
(`fig5_02` → 5a, `fig6_02` → 6s2, `fig6_03` → 6s3, `fig6_04` → 6e; `fig5_01` and
`fig5_02` both say "Fig 5b"; `fig6_02` and `fig6_05` both say "Fig 6b"; `fig6_03` and
`fig6_06` both say "Fig 6c"; `fig6_04` and `fig6_07` both say "Fig 6d").

---

## Panels that are fine

Brief, so it does not pad:

- **fig1a (pipeline)** — six stages, matching legacy, correctly marks the three contributions and correctly does *not* claim the detector. Only the whitespace (1.7) is at issue.
- **fig2c (reprojection CDF)** — both references drawn, solid/dashed key correct, all three printed numbers verify, and the choice to plot the flattering curve too is exactly the right disclosure.
- **fig3a (association schematic)** — the redraw from crossing lines to search shapes is a real improvement; credit is on the artwork. Only the 4.55 pt `C` is a defect.
- **fig4a (three solvers)** — the nomenclature correction is right, carries no numbers, and labels each solver's status in the shipped app.
- **fig4e (per-session paired)** — genuinely paired, the median rules are the median *of the dots*, and `(enforced)` is printed on the group that cannot come out otherwise. This is the most honest panel in the set.
- **fig5b (loop)** — correctly has no "rank" box, and the bracket now spans the three one-frame-at-a-time stages.
- **fig6s2 (mean pose)** — the only panel with a scale bar; 64.5 mm verifies.
- **fig7e (error decomposition)** — omitting false negatives and stating their share in the footer is the right call, and the panel does not pretend LUC3D wins on within-view switches. Only the `k`-rounding (7e row above) is at issue.
