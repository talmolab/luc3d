# `figs/` — paper figures

Figures for the LUC3D paper, generated from the **real app driven over real data** —
no mock-ups, no hand-placed skeletons. Every panel that shows pose comes out of
LUC3D's own canvases after the actual pipeline (load → Track All → Triangulate All)
runs, and every number in an annotation is read back from that run.

## Style: this follows `talmolab/figures-mimic-mjx`

The panel look is taken from the lab's MIMIC-MJX figure repo, **measured rather than
eyeballed** — every number in `src/style.py` was read out of that repo's own
committed panel PDFs with PyMuPDF:

* **Arial 8 pt everywhere.** Not 6, not 7.
* **~76 mm panels** (`figsize=(3, 2.5)` + `bbox_inches="tight"`), 600 dpi, transparent.
* **0.8 pt** axes/spines/ticks, **2.0 pt** data lines.
* **seaborn Set2** (`#66C2A5` `#FC8D62` `#8DA0CB`), verified byte-exact against their fills.
* **Despined.** Top and right always; often the left too, leaving bare tick dashes.
* **Coloured bold text instead of a legend box** (`text_legend`), and series named
  directly on the data (`annotate_series`).
* **One idea per panel, one panel per file.** Panel letters, titles and footers are
  NOT drawn into panels — they belong to assembly.

The Cheese3D paper (*Nat Neurosci* 2026) is the reference for the **schematics**:
flat line art at one stroke weight, no shading or gradients, colour only where it
carries meaning. That lives in `src/diagram.py`.

## Layout

```
figs/
  panels/figN_MM_slug.py   one script per panel          TRACKED
  src/style.py             the house style + save/deposit helpers
  src/diagram.py           line-art primitives for schematics
  src/data_loader.py       reads figs/out/*.json
  src/tools_table.py       Fig 1d's cells + what each one rests on
  data/figN/*.csv          small plot-ready tables       TRACKED
  figures/figN/            figNx_slug.pdf + .png, and figN.pdf (the composite)
  assemble.py              places panel PDFs into composites
  make_figures.py          build everything
  out/                     raw measurement deposits + app PNGs   (gitignored)
  legacy/                  the retired nature.py composite path  (see its README)
```

`data/` and `figures/` **are committed**, deliberately: the figures must be
buildable and auditable from a fresh clone without re-running a measurement pass
that needs the bench environment and the raw corpora. That is the reference repo's
idiom — the expensive pass deposits a table, the plotting pass reads it back.

## Pipeline

```bash
# 1. Measurement (slow, needs the corpora / the app). Writes figs/out/*.json + PNGs.
python3 figs/build_fig_session.py     # the trimmed 8-camera clip -> figs/session/
node    figs/fig1_tracking.mjs        # app screenshots + manifest
python3 figs/fig2_measure.py          # bench env
node    figs/fig4_measure.mjs
python3 figs/fig6_detections.py       # bench env
#    ... see the per-panel scripts' docstrings for the exact input each one needs

# 2. Panels + composites (fast, pure Python).
python3 figs/make_figures.py          # everything
python3 figs/make_figures.py 2 4      # only figures 2 and 4
python3 figs/make_figures.py --panels # panels only, skip assembly
```

Each panel script runs standalone too — `python3 figs/panels/fig4_02_accuracy_vs_cameras.py`
— and each prints the exact command to run if its input is missing.

Requires matplotlib / seaborn / pandas / numpy / h5py / pymupdf. `figs/.venv/` is
gitignored; create it with `python3 -m venv figs/.venv && figs/.venv/bin/pip install
matplotlib seaborn pandas numpy h5py pymupdf`.

**Fonts.** Real Arial comes from `apt install ttf-mscorefonts-installer` (the same
note the reference repo's README carries). Without it the stack falls through to
Liberation Sans, which is metric-compatible with Arial — layout is identical, only
the embedded font name differs.

## Files

| File | What it is |
|---|---|
| `make_figures.py` | Builds every panel (one subprocess each, so a panel that leaves rcParams behind cannot affect the next) then assembles. Reports failures by name with the reason. |
| `assemble.py` | Places the panel PDFs into `figures/figN/figN.pdf` as **vector** content (`show_pdf_page`). Draws the three things that belong to the figure rather than the panel: **panel letters** (Helvetica-Bold 9 pt), **panel titles** (`TITLES`, 7.5 pt beside the letter) and the **provenance footer** (`FOOTERS`, 6.5 pt). Layout is **by rows** — only membership is declared; each panel is placed at its own true size read from its PDF, so nothing can overlap or sit ragged. **`LAYOUTS`, `TITLES` and `FOOTERS` must be edited together**: a title or footer letter that has drifted onto the wrong panel is worse than none, and that has happened once already (Fig 3's footer after the cost-schematic was inserted as b). It **refuses** a row wider than 180 mm rather than centring it off-page, and warns past 200 mm. |
| `src/style.py` | The measured mimic-mjx style. `use()`, `panel()`, `text_legend()`, `annotate_series()`, `image_row()`, `save()`, `deposit()`. |
| `src/diagram.py` | Cheese3D-style line art: `camera()`, `ray()`, `point()`, `residual()`, `lock()`, `free()`, `loop()`. Deliberately small. |
| `src/tools_table.py` | Fig 1d's comparison table and the provenance of every cell. **Single source of truth** — read its docstring before editing any cell. |
| `panels/*.py` | One panel each. The docstring says what the panel claims, what it must NOT be read as claiming, and which file it reads. |
| `build_fig_session.py` | Cuts an 8-camera window (default frames 24551–24850, the longest run where all 8 views see all 3 mice) out of `_bugdata/20260605_133431-HardFight{,_reencoded}` and rewrites each `.slp` onto it. Frame-accurate: decodes from frame 0 rather than input-seeking, because a keyframe-snapped seek would silently shift every label. |
| `_drive.mjs` | Playwright driver: load the session, navigate frames, Track All, Triangulate All, colour mode, timeline mode, "Show Camera View", pane layout, and `exportViews()` — which composites each view's video + overlay canvas at **native 1280×1024** and records each animal's centroid, box, track, per-frame identity, and the exact colour the app drew it in. |
| `fig1_tracking.mjs` | Runs the pipeline and writes Fig 1's source panels + `fig1.json`. |
| `fig1_rig.mjs` | Sweeps rig framings for Fig 1c (orbit azimuth taken from a real top camera x elevation x zoom) so one can be chosen by eye. |
| `fig2_protocol.mjs` | Stages the reprojection-aided labelling protocol in the app for Fig 2a: label 2 anchors → triangulate from ONLY those two (via the app's Camera Views weights) → reprojections in the rest → accept/nudge. Records the app's own per-view reprojection errors. |
| `fig2_measure.py` | Measures Fig 2b/2c on real proofread BMimica data. Run with the bench env. |
| `fig5_panel_a.mjs` | Stages Fig 5a in the app: Track All -> Triangulate All with **all** views contributing, then exports the tiles plus the app's own per-view reprojection errors (`fig5a.json`). Exists because Fig 5a used to reuse Fig 2's **two-anchor** frame, which inflated every non-anchor residual by design and made its headline number an artefact. |
| `probe.mjs`, `fig1_gui.mjs` | Earlier full-GUI screenshot passes. Kept because the whole-window shot is still useful for docs/slides, but it is **not** the figure — at print size the 8-pane GUI is illegible, which is why Fig 1b uses native-resolution crops instead. **Naming rule (enforced): every file these two write is prefixed `gui-`, and no `panels/*.py` may read a `gui-*` file.** They used to write `fig1b-*.png` / `probe-full.png`, names indistinguishable from Fig 1's real panel sources — which is how `panels/fig1_03_reconstruction.py` came to read two stale pre-`setIdentityPalette()` files for weeks (see below). Do not reintroduce figure-shaped names here; a panel's source must come from the driver named after that figure. |
| `lint_text.py` | Finds overlapping and clipped text in the RENDERED panel PDFs, by measuring every text span's bounding box. Non-zero exit if anything is found, so it works as a pre-submission gate. This is the useful half of the legacy `lint.py`, reinstated for the same reason: these defects exist only in the emitted geometry and reading the generator source never finds them. It caught 55 on its first run. |
| `legacy/` | The retired `nature.py` composite-SVG path (`fig1.py`…`fig6.py`, `lint.py`, `render.mjs`). Not part of the build; kept for the provenance in its docstrings. See `legacy/README.md`. |

## The column grid, and why panels are saved WITHOUT tight bbox

Panels declare a **span** on a 180 mm grid (`full` / `two-thirds` / `half` / `third`
/ `quarter`) and a **row height**, and `save()` writes the PDF at exactly that size.
`constrained_layout` fits labels *inside* the box.

This matters. The first version of this rewrite let every panel pick its own
`figsize` and saved with `bbox_inches="tight"`, so a panel's finished width depended
on how long its tick labels happened to be. Assembled, rows came out ragged and no
two panels' plot frames lined up. `assemble.py` now reads each panel's true size and
lays rows out with one gutter, so nothing can overlap and same-class panels are
identical.

The same change is why `lint_text.py` exists: with an exact page, anything drawn
outside the axes (`ax.text(0.5, -0.2, ...)`, `text_legend` at y = 1.04) is simply cut
off rather than silently growing the page. Use `footnote()` for notes under the axis
and `text_legend()` for keys; both stay inside.

## Fixed, and the wrong diagnosis that delayed it

**Fig 1c's identity palette (fixed).** Fig 1c showed the same three animals in a
different palette from Fig 1b — green/magenta/cyan against Okabe-Ito — which
defeated the panel's whole purpose (comparing the 3D against the video tile beside
it) and put the deuteranopia-converging pair back on the artwork.

**The diagnosis recorded here was wrong**, and it cost a re-run to find out.
This file previously said `setIdentityPalette()` was "not wired into
`fig1_tracking.mjs`". It *was* wired, correctly, after `trackAll()`, and that
driver's exports were already Okabe-Ito. The real cause: `panels/fig1_03_reconstruction.py`
was reading `fig1b-e-3d-camview-clean.png` / `fig1b-d2-3d-rig.png` — output of the
**older `fig1_gui.mjs`**, last written 2026-08-03, before the palette helper existed
anywhere. The panel was consuming a stale driver's files, so re-running
`fig1_tracking.mjs` could never have fixed it. It now reads `tri3d-camview.png` /
`tri3d-rig.png`.

Two lessons worth keeping: when an export looks stale, check WHICH driver writes the
file the panel actually opens; and an ambiguous filename is itself the bug — as long
as `fig1_gui.mjs` wrote `fig1b-*` names, a re-run would recreate exactly the files
that got picked up by mistake.

**The trap is now disarmed.** `fig1_gui.mjs` and `probe.mjs` write only `gui-*`
names (`gui-a-predictions.png` … `gui-i-full-matched.png`, `gui-probe-full.png`),
both carry a header saying their output must not be read by any panel, and the 21
orphaned `fig1b-*.png` / `probe-full.png` files were deleted from `out/` after
grepping `panels/` to confirm nothing read them. `fig1b_reid_ledger.csv`
(`panels/fig1_02_tracking.py`, under `data/fig1/`) is unrelated and stays.

**The rig tile (fixed), and a premise that was also wrong.** The old export was
800x1696 portrait with the rig occupying ~19% of frame and camera labels clipped at
the right edge. The obvious fix — export much larger — makes it **worse**, which was
verified at 4000x2560: three.js `LineBasicMaterial` ignores `linewidth` on every
WebGL backend, so a frustum edge is **1 device pixel at any canvas size**, and the
camera labels are fixed-size bitmap sprites. Both therefore shrink *relative to the
content* as the canvas grows: 3400 px of crop in a 48 mm tile is a 0.014 mm stroke,
i.e. invisible. The export is sized to the print instead — 1600x900 landscape, a
~1270 px crop at 26 px/mm giving a 0.038 mm stroke, matching the old apparent weight
while carrying 1.26x the linear resolution on a 1.2x wider tile. Labels are off (they
cannot be made legible at any size); `rigFit().camScreen` is in the manifest if a
composer wants to typeset real names.

## Whitespace: what is structural and what is waste

An adversarial review measured "19-35 % blank rows" across the composites and read it
as wasted page. Most of it is not waste, and the distinction is worth recording so it
is not re-chased.

A composite's blank scanlines include the space BETWEEN panel rows, and that space is
load-bearing: `MARGIN` + `LETTER_LEAD` + `ROW_GAP` per row + the provenance footer is
where the panel letters and titles live. Measured on the current build, that structure
alone accounts for **22.6 %** of Fig 4 and **22.5 %** of Fig 5 -- against total blank
fractions of 18.7 % and 23.2 %. In other words the gaps ARE the figure's typography,
and deleting them would delete the titles.

The actionable number is blank INSIDE a panel, which is where a `row=` taller than its
ink shows up. That has been driven down: Fig 1 34.7 -> 25.5 %, Fig 6 31.6 -> 26.2 %,
Fig 5 27.2 -> 23.2 %, and `fig1a` 29.4 -> ~0, `fig1d` 37.9 -> ~0, `fig5b_loop`
40.1 -> 23.5 % (the residue there is the equal-aspect schematic's own letterboxing, and
shrinking the row would shrink the chevrons rather than the gap).

Two traps if you do tighten a panel:
* `blank()` sets `aspect="equal"`, so a schematic panel's axes is HEIGHT-bound and the
  row height sets the drawing's print scale. Pin the scale and derive the height;
  dropping `row=` shrinks the artwork.
* Table whitespace is usually interline LEADING, not one dead band. Reduce row pitch in
  POINTS and pin anything specified in data units (rule offsets, tick geometry) so it
  cannot scale with the pitch.

## Known defects in the current build

* **Fig 7f cannot plot ByteTrack's points.** `detector_recall_corr.per_session`
  carries recall / LUC3D / SLEAP / animals only, and ByteTrack's per-session IDF1
  survives just as a *sorted* list, so session identity is gone. Its `r = 0.780` is
  named on the artwork instead. Regenerating the pairing needs the bench re-run.
* **Fig 7b has no intervals** because `by_bedding` deposits no per-session values.
  It is a BETWEEN-session comparison (44 vs 30 different sessions) and is drawn as
  grouped bars, not a paired slope, so it cannot be misread — but the animal mix
  also differs (1 animal 21/44 vs 11/30) and that confound is stated, not removed.

## Things worth knowing

**Why native-resolution crops, not GUI screenshots.** A view pane is a CSS-scaled
1280×1024 canvas laid out 4-across, so a pane crop is ~300 px wide and a mouse is a
few dozen pixels — unreadable in print. `exportViews()` reads the canvases
themselves and the manifest says where the animals are, so tiles can be cropped
tight and still carry real detail.

**Why "Show Camera View" for the 3D panel.** An arbitrary orbit angle cannot be
checked against anything. Setting the 3D viewport to a real camera's perspective
(the app's own button) puts the 3D skeletons exactly where that camera's 2D pane
shows the animals; the panel then also reuses the *same normalised crop*, so the
reader can compare 3D against the image rather than taking it on faith.

**Brightness.** The app applies per-view brightness as a CSS filter on the pane,
which is *not* in the canvas pixels — `exportViews({brightness})` re-applies it when
compositing, to the video only, never the overlay. These are dark IR frames; the
default 1.9 is a display gain, applied identically to every tile in a figure.

**Overlay geometry.** The app's marker sizes are tuned for panes at ~1:3 CSS scale;
at native resolution they are chunky X's that swamp a 40 mm tile. `setOverlayStyle`
sets the real Visibility sliders (so the app's own `getVisibilitySettings()` is what
changes) rather than drawing anything different.

**Which way is up.** This rig's calibration frame has **+Z pointing DOWN** — the
overhead cameras have a *smaller* z than the animals on the floor. Assuming Z-up (the
viewport's default) renders the rig upside down, animals floating above the cameras,
which is how the first pass of Fig 1c came out. `rigFit()` takes "up" from the data
instead: whichever Z direction points from the animals toward the cameras.

**Framing the rig.** The app's own "Show Initial View" fits the scene bounds, which
leaves the animals a few pixels across. `rigFit()` projects the real content (every
camera plus the animals), takes its bounding box in the render, and then scales the
viewing distance *and* pans so that box fills and centres the frame. Fitting a
bounding sphere was tried first and is both loose and off-centre — the rig is a
flat-ish shell whose centroid is not where the content lands on screen.

**`set3dChrome` used to be a no-op.** It guarded its rebuild on
`viewport.updateCameras()`, which does not exist; the method is
`addCameraPyramids()`. So the flags were assigned and never applied, and
`labels: false` silently did nothing. Fixed, and it now also controls the reference
grid (a bare `GridHelper` at world Z=0, which on this rig floats *above* everything).

**Panel d is third-party claims.** Every non-LUC3D cell describes someone else's
software from its published docs. `NEEDS_CHECK` in `fig1.py` prints a warning onto
the figure; re-verify against current docs and date the check in the caption before
submission.

## Fig 2's numbers

**These numbers were stale for a long time** — this block reproduced
`fig2_12sessions.json` while every rendered figure had moved to the 50-session file.
Corrected below against the live `figs/out/fig2.json`; the superseded 12-session values
are kept only where the difference is instructive.

Measured on **all 50 BMimica sessions** (5 calibrated cameras, 2 mice, 15 nodes,
**1,277,424 keypoints**; 38,322,720 held-out view measurements). Each keypoint is
triangulated from **two** views and the result reprojected into the views that were
*not* used. There are **two** references, and they answer different questions:

| reference | median | p95 | p99 | ≤5 px | ≤10 px | ≤20 px |
|---|---|---|---|---|---|---|
| the held-out view's own detection | **4.32 px** | 10.20 | 14.91 | 59.9% | 94.6% | **99.68%** |
| the fully-informed reference 3D | **2.67 px** | 8.15 | 12.07 | 81.1% | 97.7% | **99.86%** |

The gap (~1.65 px at the median) is the held-out view's **own detection noise** — error a
labeller would have introduced by hand in that view anyway, not a cost of the protocol.
So the first row is conservative and the second is optimistic-by-shared-bias; every
headline number quotes the **first**. (Old 12-session value: 2.15 px, which was the
*second* reference — part of why the two got conflated.)

3D error against the all-views proofread reconstruction, by number of views labelled:
**2 → 4.75 mm, 3 → 2.91, 4 → 1.92, 5 → 1.22** (was 4.12 / 2.63 / 1.83 / 1.24). So two
anchors cost ~3.5 mm of median 3D accuracy on a ~67 mm nose-to-trunk mouse, and remove
(C−2)/C of the placements.

**The two-view cost is a property of the PAIR, not of two-view triangulation.** The
pooled 4.75 mm averages over all ten camera pairs. Per pair it tracks the baseline
angle the two cameras subtend at the animal (Pearson r = **−0.657**, Spearman **−0.88**):
the narrowest pair (**13.5° → 12.59 mm**), the widest (**31.5° → 2.69 mm**). The
rank-based statement is stronger than either correlation: the widest pair is the most
accurate in **50/50 sessions** and the narrowest the least accurate in **50/50**. So the
actionable advice is to label two views that see the animal from genuinely *different*
directions. Note this concerns only which two views you LABEL: the final reconstruction
should still use every available view (1.22 mm).

### Two things that did NOT work, recorded so they are not retried blindly

* **Bone-length variance does not discriminate.** It is the obvious 3D-consistency
  metric and it was the first thing tried. Coefficient of variation is **0.156** for
  independently-estimated per-view 2D versus **0.150** for the proofread 3D — a
  consistent but ~3.7% relative reduction, lower on 613 of 700 session×edge pairs, and
  far too small to carry a panel. At this scale bone length is dominated by real animal
  deformation (these edges span a flexing body), not by labelling error. Fig 2c reports
  per-keypoint reprojection error and 3D error instead. (These are **means** over 700
  session×edge pairs, which is what `fig2.py:167-168` computes; the old 0.149-vs-0.142
  pair was the *median* from the superseded 12-session file — quote one or the other,
  never a median from one file beside a mean from another.)
* **Cross-view residual has no dramatic tail on this data** (median **2.584** px):
  the independent per-view 2D comes from a well-trained network on a rig with good
  calibration, so the views already agree closely. The "independent labelling is
  geometrically inconsistent" story cannot be told from this dataset.

## Fig 6 — datasets

`fig6_measure.py` then `fig6_pose.py`, both with the bench env. Everything is read
from the files:

| corpus | cameras | animals | sessions w/ 3D | frames | hours | complete 3D |
|---|---|---|---|---|---|---|
| BMimica | 5 | 2 | 56/56 | 10,084,734 | 18.7 @150 fps | 56/56 |
| SLAP-2M | 8 | 1–4 | 74/84 | 1,954,440 | 10.9 @50 fps | 74/74 |
| **total** | | 1–4 | **130** | **12,039,174** | **29.5** | |

Panel a is drawn from the calibration extrinsics (camera positions `-R^T t` and
optical axes). Panel b is the generalised-Procrustes median of 1,802 complete
proofread poses, nose-to-trunk **64.5 mm** — which independently agrees with the
~67 mm median bone length measured for Fig 2.

**Panel c asserts no behaviour labels.** The outline asks for "sniffing, mounting,
chasing"; neither corpus has behaviour annotations, so the panel reports only what
is measurable — trunk-to-trunk distance and the angle between body axes — at three
proximity percentiles (81 / 259 / 603 mm). Do not relabel these as named behaviours
without an annotation pass.

## Fig 3 — cross-view association (planned)

**The comparison is legitimate, but two different components share a name.**
`pose/cross-view-tracker.js` is a faithful port of Liezl Maree's *temporal*
`CrossViewTracker` from `talmolab/sleap-3d`. The method Fig 3 contrasts against is
different: the *annotation-time multi-view association* in

> Maree, Afshar, Oline, Leonardis, Falkner & Pereira (2024). Multi-view
> triangulation-enabled annotation for multi-animal 3D pose in SLEAP.
> *Proceedings of Measuring Behavior 2024*, 217–224.

which uses **exhaustive hypothesis testing**: enumerate every grouping of instances
into identities, triangulate and reproject each, and keep the grouping with the
lowest reprojection error. Its cost is **(A!)^C** hypotheses per frame for A animals
and C cameras — `A!` view-hypotheses per view (their Fig 4), raised to the number of
views (their Fig 5) — i.e. factorial in animals, exponential in cameras (their
Fig 6). Their "Future directions ▸ Faster multi-view association" explicitly proposes
a **greedy** variant that hard-commits each view's assignment, which is exactly what
LUC3D's per-view Hungarian does. So Fig 3 answers a question that paper poses; credit
Maree for both the exhaustive method and the greedy idea.

Cost function actually implemented (`_adjacency2d` + `_adjacency3d`), for target *t*
and detection *d*, summed over nodes *k* with weight *w<sub>k</sub>*:

* 2D term: `w_k · corr2d · (1 − ‖d_k − π(t_k)‖ / (velThresh·(1+Δt))) · e^(−timePenalty·Δt)`
* 3D term: `w_k · corr3d · (1 − dist(t_k, ray(d_k)) / distThresh)`

in **normalised** camera coordinates, with the bare extrinsic `[R|t]` as the
projection matrix. Cost = −adjacency, one Hungarian solve per camera per frame, each
mutating the shared target list before the next camera. Defaults `corr2d = 1.0`,
`corr3d = 6.0` — and the header explains *why* 6: `velocityThreshold` is in
normalised image units, so the 2D term saturates and the 3D term is the meaningful
knob. Thresholds are **soft** (drive the term negative), not gates.

Status of the panels:
* **3a, 3b** — drawable now from the paper + the code above.
* **3c** — LUC3D runtime is measurable with `scripts/bench/bench_crossview.mjs`
  (it reports `runtimeSeconds`/`fps` and takes `--cameras`/`--num-animals`); the
  exhaustive curve is the exact analytic `(A!)^C`.
* **3d, 3f** — **IDF1 + ID-switches**, not HOTA: nothing in luc3d-bench computes
  HOTA, and the `corr3dWeight = 6` champion claim was established on IDF1. The
  corr2d×corr3d grid still needs running.
* **3e** — head-to-head is *implementable*: exhaustive is only `2^5 = 32` hypotheses
  at 2 animals / 5 cameras, so it can be run for real on BMimica and compared
  against the Hungarian on identical detections. It becomes intractable at
  4 animals / 6 cameras (`24^6 ≈ 1.9 × 10^8`), which is the panel's point.
* **3g** — track-length distributions and sustained-identity fractions from real
  tracker runs; no new machinery needed.

## Fig 4 — DLT vs non-linear refinement (measured, from `eric/bundle-adj`)

`fig4_export.py` (real BMimica observations) then `fig4_measure.mjs`, which imports
the **`eric/bundle-adj` worktree's** `pose/triangulation.js` read-only. **All 50
sessions, 3 calibrations, 4,253,636 keypoints at stride 60**, 5 cameras, median
distortion displacement **8.42 px** (p95 23.36) — so native-vs-ideal space is a real
distinction here, not a vacuous one.

| method | reproj p50 | µs/keypoint | worse than DLT |
|---|---|---|---|
| DLT | 2.245 px | 6.3 | — |
| refined (post-fix) | **2.056 px** | 43.8 | **0 / 4,253,636** (enforced) |
| refined (pre-fix options) | — | — | **1,048,210 / 4,253,636 (24.6%)** |

The cost ratio reproduces at **6.9x** DLT, against the 4.6–6.1x the commit message
records. The 0/4,253,636 is **enforced by a backtracking guard, not observed** — see the
tautology note below.

**The earlier version of this table was a 1-session run and its numbers were all
different** (5,866 keypoints; DLT 1.679, refined 1.577; 39% regression; 7.1 px
distortion). Do not quote them.

**THE NAMING IS WRONG IN THE UI, and the figure must not repeat it.** The module says
so itself: the `'ba'` method holds the cameras FIXED, so it is non-linear
**triangulation** (aniposelib's `optim_points`), not bundle adjustment. True joint
bundle adjustment is a separate function, `bundleAdjustCameras` (a port of
aniposelib's `bundle_adjust_iter`), and it is deliberately **not wired to the UI**
because rewriting a project's calibration invalidates every 3D point derived from it.
So Fig 4a is a THREE-way schematic, not two:

1. **DLT** — algebraic error, closed-form SVD, in ideal-pinhole (undistorted) coords.
2. **Non-linear triangulation** (the app's "Bundle Adjustment") — cameras fixed,
   soft-L1 + L1 polish, residuals in the camera's native distorted space.
3. **Joint bundle adjustment** (`bundleAdjustCameras`) — cameras *and* structure,
   iterative with geometrically annealed outlier trimming and a Schur complement;
   scale is unobservable and deliberately not estimated.

### Do NOT make a 3D-accuracy claim against the proofread reference

Measured: BA's 3D error against the proofread 3D is *worse* than DLT's (1.72 vs
1.28 mm median), in every worst-view stratum (clean 1.21x, mid 1.57x, outlier 1.48x)
— including the stratum where a robust loss is supposed to win. The diagnostic that
explains it: **the reference's OWN native-space reprojection error is 2.41 px
(median over all 50 sessions; it was 1.88 px on the single session this was first measured
on), higher than both DLT and the refined solver.** One quantity, four values had
crept into the repo (2.0 in CAPTIONS.md, 1.92 in `fig4.py`'s docstring, 1.922 here,
1.884 p50 / 2.099 mean in `fig4.json`). **Standardised on `fig4.json`
`reference_reproj_px.p50`, always named as a median.** That value is now **2.41 px**
(mean 2.73) because Fig 4 was re-measured over all 50 sessions and 3 calibrations; the
1.88 px figure was the single-session run. Anything quoting 1.88 is stale. The proofread 3D is therefore not the
minimiser of reprojection error on these detections — it comes from a different
pipeline and, here, through a RANSAC-Procrustes alignment with its own ~1.2 mm
residual. Distance to a reference that sits *further* from the data than either
solver rewards whichever solver moved less, which is DLT by construction. It cannot
arbitrate between two methods that differ precisely in which error they minimise.

Consequences: the **reprojection** comparison is valid (measured directly against raw
detections, no reference needed) and belongs in Fig 4b. A 3D-accuracy panel needs a
real ground truth — synthetic points with known 3D, or a calibration object — which
is exactly what the branch's own tests use, and whose numbers (11–18x better under a
60 px outlier; +10% worse on clean Gaussian noise) should be quoted from there rather
than re-derived from this corpus. Note also this dataset is too clean to exercise the
robust loss at all: only a small minority of keypoints have any view off by even 10 px (66,901 of 4,253,636 at >= 10 px on the all-sessions run), versus
the 60 px gross outliers the branch's tests inject.

`figs/fig4_hooks.mjs` exists because that branch's own `scripts/bench/hooks.mjs`
lacks a `getDefaultTriangulationMethod` export that its `pose/triangulation.js` now
imports — which also means **`scripts/bench/bench_crossview.mjs` is currently broken
on `eric/bundle-adj`**. Worth fixing there; our hooks are a local workaround so that
branch is untouched.

Fig 4d (error vs number of contributing views) is already measured by
`fig2_measure.py`: **4.75 / 2.91 / 1.92 / 1.22 mm** for 2 / 3 / 4 / 5 views (50 sessions;
the 4.12 / 2.63 / 1.83 / 1.24 figures were the superseded 12-session run). Note this
makes Fig 4d a **BMimica** panel inside an otherwise single-session figure — the
provenance mix must be flagged on the artwork.

## Fig 6 — REDESIGN REQUIRED

The first attempt (rig scatter + mean skeleton + stats table) was rejected, correctly:
it showed camera calibrations and an average pose, neither of which says anything
about what is *in* these datasets. Replace with:

* **a** — the rigs rendered in LUC3D's own 3D viewport, upright, top cameras on top
  and side cameras at the side. `rigFit()` in `_drive.mjs` already does this (it takes
  "up" from the data, see the note above); it needs SLAP-2M/BMimica loaded as app
  sessions, which means building session folders for them.
* **b** — real multi-camera screenshots with instance overlays, contrasting difficulty:
  white bedding + white mice against black bedding + agouti/black mice, which is what
  actually makes a session hard.
* **c** — **reprojection error by difficulty**, the informative metric.
* **d** — stats table organised BY DIFFICULTY STRATUM rather than one flat corpus row.

**THREE DEPOSITS DESCRIBE "difficulty", AND THEY ARE NOT THE SAME MEASUREMENT.** This
block used to quote one of them without saying which, which is how an adversarial
review came to read it as stale. It is not stale — it described a source the figure has
since stopped using. Both facts matter, so both are recorded:

| deposit | n | difficulty | bedding | what it measures |
|---|---|---|---|---|
| `fig6_detections.json` | **74** | **1–7** (12/13/9/13/10/4/13) | — | the benchmark's shared identity-stripped **raw detections** vs the proofread 3D reprojected into each camera. **This is what panels c, d and f read.** |
| `fig6_difficulty.json` | 42 | 2–7 (13 at 7, 10 each at 2 and 4) | black 23 / white 19 | **proofread labels** vs the same reference — i.e. the reconstruction's own 2D→3D residual. Legacy called this a "circular comparison" and used it only as a fallback. |
| `fig3_trackers.json slap2m.by_bedding` | 74 | — | black 44 / white 30 | tracker IDF1 by bedding. **This is what Fig 7b reads.** |

The two 74-session tables disagree on the 2-animal miss rate by ~50 % (21.95 % vs
33.19 %) and that gap is a **result**, not an inconsistency to reconcile: the raw
detector misses far more than the residual path suggests, which is what you expect when
the residual path cannot see a detection that never fired. `fig6_07_animal_count.py`'s
docstring records the reasoning for reading `fig6_detections.json`.

Both `_multi_master.tsv` fields the original plan wanted — `obstacle_rating` 0–5 and the
coat-colour counts — are still unused by any panel.

`fig6_measure.py` / `fig6_pose.py` are kept for the corpus totals (130 sessions,
12,039,174 frames, 29.5 h) which are still wanted for the text; `legacy/fig6.py`'s panel
layout is superseded.

## Open## Open

* **Wall-clock labelling time is still not measured.** Fig 2b reports manual
  *placements*, which is what the protocol actually changes, and the panel says so.
  Turning that into a time claim needs either app instrumentation (log per-frame
  labelling time) or a small timed study with real annotators.
* **The "independent human labelling" condition does not exist in any dataset here.**
  Fig 2's contrast is 2-anchor-and-accept versus label-every-view, both from the same
  observations. A study where annotators label views independently would be needed to
  claim anything about human cross-view inconsistency.
* **Panel a and panels b/c come from different rigs** (8-camera HardFight for the
  app staging, 5-camera BMimica for the measurements) because only BMimica has a
  proofread 3D reconstruction to measure against. Stated in the figure's footer.

---

## Parallel adversarial review round (2026-08-04)

Two audit agents ran first and their verbatim reports are kept in the repo as the
defect record, because several findings change numbers that are already on the artwork:

- `REVIEW-captions-vs-data.md` — every caption claim recomputed from the deposited
  JSON using the generator's own aggregation path. Figure-sectioned.
- `REVIEW-bench-sweep.md` — maps what unit of replication actually exists in
  `luc3d-bench/outputs/` and lists the strong results no figure was using.

Then one agent per figure, fixing that figure's section plus a fresh hostile-reviewer
pass. Fig 3 and Fig 7 went to a single agent because **one generator (`fig3.py`) emits
both** — they cannot be edited concurrently.

Rules imposed so six agents could run at once without clobbering each other:
- `nature.py` is off-limits to all of them (shared by every figure). Needed helpers get
  implemented locally in the figure generator or reported back.
- `CAPTIONS.md` is off-limits. Each agent writes `figs/captions/figN.md`, merged here
  afterwards. Six concurrent writers to one caption file would have lost work.
- `fig6_detections.json` is read by BOTH fig5 and fig6, so schema changes to it are
  additive-only. A key mismatch in exactly that file (`capture_oracle` vs
  `capture_by_oracle`) had already silently dropped Fig 5c's oracle series once.
- `pose/triangulation.js` in the `eric/bundle-adj` worktree is read-only — the user is
  actively working on that branch.

### The two headline integrity items handed to agents

**Fig 7 provenance.** `luc3d-bench/outputs/metrics/` holds three different runs in one
directory (LUC3D IDF1 0.738301 / 0.736490 / 0.7383 depending on file), and
`PAF_3d_kalman/metrics/headline.csv` shows the shipped baseline at 0.73604 against
PAF-L1 at 0.73809 — so the cells labelled "luc3d" in that directory sit closest to the
**variant, not the shipped tool**. One file must be chosen, justified, and hard-wired
into `fig3_trackers.py` so it cannot drift again.

**Fig 4 tautology.** "Refined is never worse than DLT" is enforced by the polish phase
minimising the reported metric plus a backtracking guard — it cannot come out worse. The
contingent quantities are the leave-one-camera-out held-out comparison (DLT 2.27 px vs
refined 2.35 px — the refinement does **not** generalise) and the pre-#113 regression
rate. The negative held-out result is the honest headline.

### Fig 2c: the baseline-angle relationship is dominant, not sole

The x-axis is the angle the two anchor cameras subtend **at the animal** (vertex = mean
proofread 3D point; camera centres from the extrinsics as `C = -R^T t`). Fitting the
depth-uncertainty law `err = k/sin(theta)` **robustly**, as `k = median(err*sin(theta))
= 1.52 mm`, puts 8 of the 10 pairs within +/-25%.

Do not quote k = 1.87 mm with the 8-of-10 count -- that was my error and the Fig 2 agent
caught it. 1.87 mm is the **plain least-squares** fit, and it puts only **5 of 10** pairs
inside +/-25% (it misses `0-2`, `1-2`, `1-4`, `2-3`, `2-4`), because least squares is
dragged upward by the two outliers it is supposed to be diagnosing. The robust fit misses
exactly the two genuine exceptions, `0-2` and `1-2`, which is the point of the panel. The two misses (`1-2` at 13.4 deg, `0-2` at 18.1 deg) both pair camera 2
— the farthest camera, 1.32 m to the animals against ~1.0 m for the other four — with its
two angular neighbours; note 18.1 + 13.4 = 31.5 = the `0-1` angle exactly, so cameras
0, 2, 1 are coplanar with the animal. Narrow angle and coarse mm-per-pixel compound there.

Two claims of very different strength come out of this and must not be conflated:
* **Directly measured, an annotation instruction.** Given this rig as built, pick the two
  anchor views that see the animal from the most different directions: 2.69 mm against
  12.59 mm, a 4.7x difference free at annotation time. The rank-based form is stronger
  than the correlation and is what the caption now leads with: the widest pair (`0+1`) is
  the most accurate in **50/50 sessions** and the narrowest (`1+2`) the least accurate in
  **50/50 sessions** (Spearman -0.88; Pearson r = -0.657).
* **Extrapolation, belongs in the Discussion.** That a physically wider rig would reduce
  ambiguity follows from the geometry and is consistent with these data, but **no camera
  was ever moved** — all ten points come from one fixed 5-camera geometry, the pairs share
  cameras and one calibration so the effective n is well under 10, and the observed range
  is only 13-31 deg. The widest pair available on this rig is 31.5 deg, so every option
  sits on the steep part of the 1/sin curve.

### Colourblind-safe identity colours: `setIdentityPalette()` in `_drive.mjs`

`pose/pose-data.js` ships `IDENTITY_COLORS` as `#00ff00`, `#ff00ff`, `#00ffff`, … Those
first three are exactly the identities that appear in every figure showing more than one
animal, and under deuteranopia the green and the magenta converge — the two mice a reader
is meant to tell apart become the same colour.

`setIdentityPalette(page, colors?)` fixes this **in the live page**, not in the app: it
splices an Okabe-Ito palette into the exported `var` and then rewrites `.color` on every
identity already constructed, because `Identity`'s constructor reads the palette only at
construction time. **It must therefore be called AFTER `trackAll()`**, which is what
creates the identities — calling it before `loadSession` does nothing.

The app on disk is deliberately untouched. Its palette is tuned for on-screen work
against dark video, several figures depend on the app rendering exactly what a user sees,
and changing a shared app constant to serve the figure pipeline is precisely the kind of
edit that breaks verified-working behaviour elsewhere.

Wired into `fig2_protocol.mjs` and `fig5_panel_a.mjs`; both re-exported.

### `figs/lint.py` — mechanical checks on the RENDERED SVGs

Three defect classes recurred across the set and none of them was visible in the
generator source, because they only exist in the emitted geometry:

1. **Type below Nature's 5 pt floor** — 50 runs in Fig 5 alone, at 4.6 pt (1.15 mm cap
   height) on the bar labels a reader is *meant* to read.
2. **Text crossing the 180 mm trim edge** — silently clipped in the render. Fig 2 had a
   footer ending at 197.5 mm whose tail simply was not drawn.
3. **Artwork over ~200 mm** — Fig 1 reached 236.7 mm, and a ~47 mm caption puts the total
   near 284 mm against a 247 mm page. `nature.py`'s own `MAX_H` was set too high to catch
   it.

Run `python3 figs/lint.py [paths]`; exit status is non-zero on failure, so it works as a
pre-submission gate. **Its width check was dead on arrival** and is worth knowing about:
`text_width()` takes **points** and returns mm, and passing the SVG's millimetre
`font-size` underestimated every width by 1/PT = 2.83x, so nothing ever tripped. Fixed,
and guarded with a positive control (a deliberately overhanging run must FAIL) plus a
negative control — a checker nobody has seen fail is not a checker.

It knows nothing about *vertical* collisions or text landing on data marks, which is how
Fig 4 shipped a render with three panel titles struck through by panel a. Reading the PNG
is not optional.

### An app bug found while re-staging Fig 5, NOT fixed here

`ui/overlays.js:2031` reads `labelSize: (userOpts && userOpts.labelSize) || 11`, so a
requested label size of **0 falls back to 11** — `||` treating 0 as absent. That is why
`setOverlayStyle(page, { userLabelSize: 0 })` never suppressed the identity text pills;
the staging drivers pass 1 as a workaround. Worth a real fix in the app (`?? 11`), which
is out of scope for the figure pipeline.

### Fig 4 over all 50 sessions REVERSED the held-out conclusion

The single-session run said the refinement does **not** generalise: held-out DLT 2.27 px
against refined 2.35 px, i.e. worse out of sample. I reported that to the user as the
figure's honest headline. **On all 50 sessions and 3 calibrations (4,253,636 keypoints at
stride 60) the sign flips**: held-out median DLT **3.051** px against refined **2.971** px,
so the refinement is better out of sample — but only just, and the effect is negligible:

* median paired difference **0.058 px**, a 2.6% reduction;
* refined wins on **53.1%** of individual held-out keypoints (11,301,539 of 21,268,180) —
  barely above a coin flip;
* refined lower in **34 of 50** sessions.

So neither of the two clean stories is true. It is not "the refinement does not
generalise" (n = 1 artefact, wrong sign) and not "the refinement improves accuracy"
(0.08 px is far below the reference's own 2.41 px error). The defensible statement is
**detectable but negligible out of sample**, which is why Fig 4 now leads with view count
(4.7 -> 1.2 mm, 3.9x) and outlier rejection (up to 7.2 mm) instead of with the solver
comparison.

This is the second time a single-session Fig 4 number misled a conclusion in this figure
set. Treat any n = 1 result here as a pilot, never as a finding.

Other numbers that moved with the full run:
* **pre-#113 regression rate: 24.6%** (1,048,210 / 4,253,636), not the 35% (12-session) or
  39% (single-session) previously quoted.
* **Median lens-distortion displacement: 8.42 px** (p95 23.36, mean 10.10, n = 1,012,775),
  now actually deposited in `fig4.json distortion_px`. The earlier 4.6 px was
  `console.log`-only and the 7.1 px in this README was from a superseded run.
* **Reference 3D's own reprojection error: 2.41 px median** (mean 2.73), up from 1.88 px.

### Fig 4's language was internal jargon, and one panel was a changelog

The all-sessions Fig 4 shipped with three phrases no reader outside this repo can parse,
and the user hit all three immediately: **"views in the solve"**, **"pre-#113"** and
**"displayed error change"**. Fixed as follows.

* Axis and title language is now plain: *cameras that saw the keypoint*, *how far that
  camera disagreed*, *the 3D point moves*, *error in an unused camera*, *cameras it used*
  vs *a camera it never saw*, *time per keypoint*. "Views in the solve" was shorthand for
  "how many cameras contributed observations to this triangulation" — obvious inside the
  code, invisible outside it.
* **Panel f (the pre-#113 regression box) is deleted.** `#113` is a GitHub issue number:
  printing it on a journal figure asks the reader to look up our tracker. Worse, the panel
  was a *changelog* item — it said a bug we already fixed used to be a bug — and "change in
  the displayed error" is not a quantity a reader can act on. The number (24.6% of
  keypoints, median +0.026 px) now lives in the caption's Supplementary Note as software
  validation, where it belongs, and `fig4.py` still prints it as a `[caption]` line.
  `BUG_C` and the third column slot were removed with it so the language cannot creep back.

Panels are now a (solvers) / b (accuracy vs cameras) / c (dropping the worst camera) /
d (error in an unused camera) / e (per session) / f (time per keypoint), 180 x 143 mm.

### Fig 7's dot swarms became survival curves

Panels c and d were 444 and 74 jittered dots. The user's objection was aesthetic but the
fix is substantive:

* **Panel c is now a survival curve** — the percentage of sessions scoring at or above
  each IDF1 threshold, one step per session, three clean strokes instead of three clouds.
  This matters because the trackers separate most in the **upper tail**, which both a
  median bar and a jittered cloud bury: at IDF1 >= 0.9 the counts are LUC3D **36/74**,
  SLEAP **22/74**, ByteTrack **10/74**, and that gap is now directly readable as a
  vertical distance at any threshold.
* **Panel d is mean + 95% CI**, no cloud. The CI carries the spread *and* carries n
  honestly — the 3- and 4-animal cells (n = 4, n = 3) get visibly wide intervals, which is
  better disclosure than plotting three dots and hoping the reader counts them. Exact n
  and win counts stay printed under each tick.

Curve names went into a lower-left key rather than onto the curves, and the >= 0.9 counts
into fixed rows right of the rule: at their own curve heights the three values sit within
~35 percentage points of each other and overprinted both each other and the strokes.

### nature.py now HARD-FAILS on the three defects lint.py finds

`MAX_H` 240 -> **200 mm** (240 was never a real ceiling: Fig 1 passed it at 236.7 mm while
needing ~284 mm once a caption is allowed for), plus `Figure.write()` now raises on any
type below 5 pt or any text past the 180 mm trim edge, naming the offenders. Four of the
seven generators had grown their own local version of this check; it is now done once.

Verified with positive controls — a 4.6 pt run, an overhanging run and a 210 mm figure each
raise, and a clean figure still writes. **A checker nobody has watched fail is not a
checker**: `lint.py`'s width test was silently dead on arrival because `text_width()` takes
POINTS and it was being handed the SVG's millimetre `font-size`, understating every width
by 1/PT = 2.83x.


### The Fig 2c "3D error" floor: what it is, and a correction I had to make

Two questions worth recording because I got the second one wrong first.

**Where the reference 3D comes from.** `<session>/*_points3d_translated_rotated_metric.h5`
in the BMimica corpus. The filename is the provenance: it was **translated, rotated and
converted to metres**, which is why it does not sit in the calibration frame. Recovered
scale is ~994.8 or ~1012.9 depending on which of the corpus's two calibrations a session
uses, i.e. the calibration frame is in millimetres and the reference is in metres;
`mm_per_unit = (1/s) * 1000` lands at 0.987-1.005, so one calibration unit is ~1 mm.
A RANSAC similarity fit (`ransac_align`) undoes the post-processing, at 97-98% inliers.

**"3D error" is therefore NOT reprojection error and NOT our-2-views against our-5-views.**
It is the 3D Euclidean distance between our DLT triangulation from k views and that
transformed proofread reference. If the reference were our own 5-view solve the k = 5 point
would be identically zero; it is 1.22 mm because the reference is external.

**The correction.** I first wrote that the 1.22 mm floor was "almost entirely frame
alignment, not triangulation", because the alignment residual (1.20 mm) and the k = 5 error
(1.22 mm) agree to 1.4%. **That reads the coincidence backwards.** Both quantities are the
*same measurement* — "our all-camera DLT of the per-camera 2D against their proofread 3D" —
one fit on a ~4,000-frame sample, the other evaluated on the strided analysis frames. Their
agreement is near-tautological and says nothing about alignment quality, which is anyway
good (97-98% inliers).

What 1.22 mm actually is: the genuine median disagreement between our five-view
reconstruction and the corpus's proofread 3D, absorbing the 2D detector's error, whatever
human 3D correction the proofread pass applied, and any residual frame mismatch. So:

* the *spacing* 4.75 -> 2.91 -> 1.92 -> 1.22 mm is real, and "two anchors cost ~3.5 mm
  relative to five" is supported;
* the *absolute* values are not absolute 3D accuracy, because the reference carries its own
  error (median reprojection 2.41 px, above either candidate solver's -- the same reason
  Fig 4 makes no 3D comparison between solvers);
* the on-artwork label is now "comparison floor", not "alignment floor", and the axis reads
  "3D error vs proofread (mm)" so it cannot be mistaken for a reprojection error.

The claim that Fig 4b's 3.9x is a lower bound *because alignment error inflates the
denominator* was withdrawn with the same reasoning. It may still be a lower bound, since
the denominator includes detector and proofreading error, but not for the stated reason.
