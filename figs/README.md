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
LP3D_PY=/root/vast/eric/luc3d-bench/lp3d_env/bin/python
$LP3D_PY figs/fig4_export.py          # stride 15 -> fig4_input.{json,bin}, 1.8 GB, ~6 min
HOV_SUB=1 DSTEP=1 node figs/fig4_measure.mjs   # ~2.3 h, no secondary subsample
#   run it on a QUIET machine: its us/keypoint is accumulated inside the sweep, and a
#   13-process load inflated it 21%/46% (7.67/64.35 against 6.32/44.00, same 17 M
#   keypoints, every accuracy field bit-identical).
# 4b, both solvers, sharded by session (BLOCKS=lo:hi) -> fig4_by_views.json, ~36 min:
for r in 0:5 5:9 9:13 13:17 17:21 21:25 25:29 29:33 33:37 37:41 41:45 45:50; do
  BLOCKS=$r STRIDE=1 OUT_JSON=figs/out/bv-$r.json node figs/fig4_by_views.mjs & done; wait
node figs/fig4_by_views.mjs --merge figs/out/bv-*.json
ANIPOSE_PY=/root/vast/eric/luc3d-bench/anipose_env/bin/python
$ANIPOSE_PY figs/fig4_anipose.py --jobs 12 --optim-jobs 12 \
    --optim-sweep 1000 2000 4000 8000 16000 23000   # 4d/4e -> fig4_anipose.json, ~2.2 h
python3 figs/fig6_detections.py --jobs 12   # bench env; stride 1 = every frame, ~80 s
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
| `assemble.py` | Places the panel PDFs into `figures/figN/figN.pdf` as **vector** content (`show_pdf_page`). Draws the two things that belong to the figure rather than the panel: **panel letters** (Helvetica-Bold 9 pt) and **panel titles** (`TITLES`, 7.5 pt beside the letter). The **provenance footer** mechanism (`FOOTERS`) is retained but every entry has been removed — figure-level provenance is caption text and now lives in `FIGURE-LEGENDS.md` / `METHODS.md`; put an entry back to print it on a working draft. Layout is **by rows** — only membership is declared; each panel is placed at its own true size read from its PDF, so nothing can overlap or sit ragged. **`LAYOUTS` and `TITLES` must be edited together**: a title that has drifted onto the wrong panel is worse than none, and that has happened once already (Fig 3's footer after the cost-schematic was inserted as b). Re-run `make_docs.py` after any re-lettering. It **refuses** a row wider than 180 mm rather than centring it off-page, and warns past 200 mm. |
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
| `make_docs.py` | Generates `PANEL-SOURCES.md` from `assemble.LAYOUTS` and the panel scripts themselves — the map from each placed panel to the script that draws it, the `out/*.json` it reads, the measurement pass that wrote that JSON, and the CSV it deposits. `--check` exits non-zero when the file is stale, so it works as a pre-submission gate. A hand-kept index of 48 panels is wrong within a week; this one cannot drift without the build changing. |
| `FIGURE-LEGENDS.md`, `FIGURE-LEGENDS.txt` | **The legends that go into the manuscript**, as `Fig. 1)` / `A)` / `B)`: finding first, then panel by panel with n and statistic. The `.txt` is the same text with no markup at all, for pasting into a word processor. **No em dashes, no bold, no tables, no backticks in either** — they survive a paste badly and the manuscript sets its own type. Nothing on the artwork duplicates them: figure-level footers and all 19 per-panel sub-captions were removed (see `FOOTERS` and `src/style.footnote`) and their content lives here. |
| `METHODS.md`, `METHODS.txt` | The procedures behind every measurement: corpora, calibration, the shared detection pool, association, triangulation, the Fig 5 behavioural definitions, tracking metrics, statistics, software versions and how the figures are built. Same markup rules and same `.txt` twin as the legends. |
| `PANEL-SOURCES.md` | Generated by `make_docs.py`; do not edit. |
| `REVIEW-REVIEWER2.md` | An adversarial referee report written against the submitted PDF, used to drive the revision. Kept as the record of what was objected to. |
| `HANDOFF-FIG2.md`, `offbox/fig2/` | **Figure 2 re-measured at every frame, moved off this box on 2026-08-11 at 25 of 56 sessions.** It was holding 138.6 GB across 14 workers, 85% of everything running. The 25 finished per-session shards and the four helper scripts are committed under `offbox/fig2/`; the launcher skips any session that already has a shard, so another machine resumes rather than restarts. |
| `HANDOFF-OFFBOX.md` | Which measurement jobs are worth running on a different machine and how. Short version: only the 4-animal 6-camera exhaustive configuration, which is the one number in the paper that is extrapolated rather than measured, travels in under 2 GB, and is parallel across frames. |
| `REVISION-LOG.md` | **What changed in response to that report, with the before and after value of every number that moved**, plus the items that are the manuscript's to fix rather than this repo's. A response-to-reviewers letter can be assembled from it. Update it whenever a measurement is re-run; the numbers in the docs are only checkable against something if that something is written down. |
| `CAPTIONS.md` | The working caption document: extended reasoning, the readings each figure must NOT support, and the analyses that were run and not shown. Source material for `FIGURE-LEGENDS.md` and for a Supplementary Note; not itself a submission artefact. |
| `fig8_param_sweeps.py` | **EXPLORATORY, NOT IN THE MANUSCRIPT.** Sweeps every remaining `CrossViewTracker` threshold one at a time (10 parameters, 35 cells) on exactly Fig 3e's measurement — same 8 BMimica sessions, full length, same detections, same `fig3_score.py`, same 7,205,370-camera-frame denominator — so its rates are directly comparable to Fig 3e's. Imports `fig3_sweep.py` for the corpus/driver/scorer rather than re-deriving them; does not modify it and does not touch `out/fig3_sweep.json`. Deposits `out/fig8_param_sweeps.json`, caches per-cell tracker runs under `out/tmp/fig8/` so it is restartable, and **reuses Fig 3e's `corr2d=1/corr3d=6` cell as the shipped-default cell by symlink** — that one configuration is the default for all ten parameters and is measured once, not ten times. Run it with the bench interpreter (`/root/vast/eric/luc3d-bench/liezl_env/bin/python`); scoring needs motmetrics. See "Fig 8" below for what it found. |
| `fig8_diag_loss.py` | **EXPLORATORY.** Decomposes the tracker's cross-view IDF1 loss into IDENTITY versus COVERAGE error, off existing result JSONs (no re-tracking): `as_is`, `oracle_id` (every LABELLED detection relabelled to its best-IoU GT box) and `oracle_full` (every detection with a bbox). Answers "what is the missing IDF1 made of" before any method is written, and sets the ceiling Fig 8d is read against. `--cell`/`--root` select any cached cell from either `tmp/fig8/` or `tmp/fig8m/`. Bench interpreter. Deposits `out/fig8_diag_loss_<cell>.json`. |
| `fig8_diag_anchor_age.py` | **EXPLORATORY.** Measures how OLD the per-camera detections are that `Target._retriangulate()` fuses into the 3D each association is scored against — the mechanism behind Fig 8d's best result. Behaviour-neutral, and that is *proved* per session by digest-comparing against the `shipped` cell, because a probe that perturbs what it measures is worthless. Deposits `out/fig8_diag_anchor_age.json`. |
| `fig8_methods.py` | **EXPLORATORY, NOT IN THE MANUSCRIPT.** ALGORITHMIC methods for the cross-view tracker on exactly Fig 8's measurement, via `figs/fig8-bench/` (an ESM loader hook serving `xv_experimental.js` in place of `pose/cross-view-tracker.js`; **no app source is modified**). `--verify` proves the fork with an empty method block is byte-identical to the shipped tracker on all 8 full sessions. `--recheck` re-tracks one session per cached cell under today's code — the cache outlives tracker edits and this is the tripwire against silently mixing code versions (it has already caught one real bug). `--all-sessions` re-runs over all 50 proofread BMimica sessions into a separate cache and deposit, since `switches` is a raw sum whose denominator differs. `--reaggregate` recomputes the per-session comparison without re-scoring. Bench interpreter. Deposits `out/fig8_methods.json`. |
| `fig8_report50.py` | Reads `out/fig8_methods_50.json` and prints the all-50-session picture: a harness cross-check against `fig3_trackers.json`'s independent 50-session LUC3D number FIRST, then medians and quartiles rather than means, per-session win/loss, worst single-session harm, and paired Wilcoxon tests. |
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
| SLAP-2M | 8 | 1–4 | 74/74 | 1,954,440 | 10.9 @50 fps | 74/74 |
| **total** | | 1–4 | **130** | **12,039,174** | **29.5** | |

**SLAP-2M is 74 sessions, and the `74/84` this table used to print was a bug.**
`fig6_measure.py` enumerated the corpus by walking `{SLAP_ROOT}/20*/<session>/`, which
holds **84** session directories — ten of them recordings that were never part of the
dataset (no 3D, no row in `master_sheet.xlsx`, no row in the benchmark's
`detections_only_master_sheet.tsv`). So `sessions_total` was 84, Fig 6e's table read
"74 of 84", and the figure claimed ten sessions of unfinished proofreading that do not
exist. `scan_slap` now joins on `master_sheet.xlsx` (74 rows, `session` /
`session_path`) and warns if a sheet row has no directory, so the count cannot drift in
either direction. Nothing else moved: the frame, hour and complete-3D columns were
already summed over the 74 sessions that have 3D.

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

**UPDATE 2026-08-14, on instruction — 3d and 3e now carry the FRESH ANCHOR
(`sync` + `stale 20` + `distanceThreshold 25`, corr3dWeight 6) alongside the shipped
arm, never substituted.** 3d gained a third series (fresh-anchor greedy, hollow teal;
data `out/fig3_quality__distanceThreshold25-stale20-sync_e508a7ab.json`, harness gated
byte-identical on 92 sessions in `out/fig3_hh_gate.json`; pooled misgrouped 1,052
shipped / 926 fresh / 1,309 exhaustive). 3e was RE-BASED from 8 sessions to the full
50-session corpus, both arms on the same 45,021,960-camera-frame denominator
(`out/fig3_sweep50.json` + the tagged fresh deposit; shipped r = 6 gives 2,071
switches / cross 0.7493, fresh 413 / 0.8613). **Every statement elsewhere in this
file that pins a number to "Fig 3e's measurement" — 8 sessions, the 7,205,370
camera-frame denominator, `out/fig3_sweep.json` — refers to the RETIRED render,
still reproducible pixel-for-pixel via `fig3_05_sweep.py --legacy8` (and 3d's via
`fig3_04_quality.py --as-shipped`); those deposits are untouched and Fig 8's
comparability to them is unaffected.**

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
sessions, 3 calibrations, 17,013,412 keypoints at stride 15**, 5 cameras, median
distortion displacement **8.41 px** (p95 23.34) — so native-vs-ideal space is a real
distinction here, not a vacuous one.

| method | reproj p50 | µs/keypoint | worse than DLT |
|---|---|---|---|
| DLT | 2.245 px | 6.3 | — |
| refined (post-fix) | **2.056 px** | 44.0 | **0 / 17,013,412** (enforced) |
| refined (pre-fix options) | — | — | **4,193,925 / 17,013,412 (24.7%)** |

The cost ratio reproduces at **7.0x** DLT, against the 4.6–6.1x the commit message
records. The 0/17,013,412 is **enforced by a backtracking guard, not observed** — see the
tautology note below.

**THE EXPORT IS AT STRIDE 15 SINCE 2026-08-12, AND EVERY ARM RUNS ON ALL OF IT.** It was
stride 60 (4,253,636 keypoints), and Fig 4b then took every 4th keypoint of that
(effective stride 240). No arm subsamples now: `fig4_measure.mjs` runs its
`heldout_by_views` and its lens-distortion fixture on every keypoint too (`HOV_SUB=1
DSTEP=1`), and `fig4_by_views.mjs` runs at `STRIDE=1`. **Nothing moved**: every median in
this section shifted by less than 1%, the 50/50 and 49/50 head-to-heads are unchanged,
and the k = 2..4 curve moved by <= 0.005 px. That stability, on 4x the data with 16x the
subsets, is the answer to "the corpus numbers rest on a subsample" — the stride-60
numbers are in `out/fig4.stride60.json`, `out/fig4_by_views.stride60-within4.json` and
`out/fig4_anipose.stride60.json` if the comparison needs to be re-made.

**What stride 15 costs, and why not stride 1.** Export is cheap (5m51s for the whole
corpus, a 1.77 GB `.bin`) and the two LUC3D arms scale linearly — but
`CameraGroup.optim_points` is ONE global least-squares per session, so its cost and
memory scale with keypoints-per-session, and it is what sets the ceiling. Measured on
one real session at five sizes: 88 k keypoints 15.9 s / 1.6 GB, 177 k 24.8 s / 3.7 GB,
353 k 55.6 s / 6.2 GB, 707 k 124 s / 11.0 GB, 884 k 169 s / 12.4 GB. A stride-1 export
is 5.3 M keypoints per session, i.e. ~75 GB and ~17 min for ONE of the 18 solves
`_block_optim` runs per session — ~4 h per session, ~200 h of CPU for the corpus, and at
most 6 workers would fit in 500 GB, so ~30 h wall clock for that arm alone. Stride 15
puts a session at 353 k, which is the last size that fits 12 workers and finished the
whole arm in 83 min.

### The Anipose arm (`fig4_anipose.py`) — and what it found

`fig4_anipose.py` runs `aniposelib.CameraGroup.triangulate` over the **same
`fig4_input.bin`** `fig4_measure.mjs` reads, so it is the same float64 detections in
the same order, not merely the same corpus. All 17,013,412 keypoints and all 85,067,060
leave-one-camera-out solves. Run it from `/root/vast/eric/luc3d-bench/anipose_env`.

**Pin: `aniposelib==0.7.2`.** That is the last release before the JAX rewrite and the
newest one `anipose` itself accepts (`Requires-Dist: aniposelib >=0.7.0`), i.e. the
original OpenCV/NumPy pipeline — `cv2.undistortPoints`, then a per-point
`numpy.linalg.svd` DLT in a Python loop. **0.8.0 is a different program**: `jax.vmap` +
`jnp.linalg.svd`, genuinely batched, and timing it against LUC3D's per-call solver
would compare batching regimes rather than solvers. `fig4_anipose.py --assert-no-jax`
(on by default) refuses to run against a JAX build; do not remove it.

**Four solvers, paired by algorithm class** — Anipose linear vs our DLT, Anipose
`optim_points` vs our refinement — because pairing their closed-form solve against our
iterative one is a category error, and drawing only their linear column invited exactly
that reading. Per-session medians over all 17,013,412 keypoints:

| | cameras it used | held-out camera | µs/keypoint |
|---|---|---|---|
| Anipose linear (`triangulate`) | 2.265 px | **3.107 px** | 29.0 |
| our DLT | 2.348 | 3.336 | **6.3** |
| Anipose optim (`optim_points`) | 2.256 | **3.111** | 228.8 |
| our refinement | **2.152** (enforced) | 3.147 | **44.0** |

Out of sample **Anipose is lower in both pairs** — 50/50 sessions on the linear pair,
49/50 on the non-linear one. We are **4.6× faster on the linear pair and 5.2× on the
non-linear one** (the non-linear ratio was 2.7× at stride 60 and moved because
`optim_points` is priced per SESSION: the cost sweep now reaches the real session size,
23,000 frames rather than 4,000). Our refinement's in-sample win is enforced (backtracking guard) and
does not survive the held-out group.

**Anipose's own optimiser buys it almost nothing**: 0.009 px in sample over its own
linear solve, and *nothing* out of sample (better in 13/50), for 7.9× the cost. Not a
failed run — it terminates on aniposelib's `ftol=1e-3` after two iterations, and
tightening to `1e-10` changes the answer by zero (1.6237 px either way). It has
converged; a normalised DLT is already at the geometric optimum. Which reframes our own
refinement's 8% in-sample gain as mostly *recovering the conditioning Anipose gets for
free* — see below.

**The other two config paths, measured and not drawn.** `anipose triangulate` reads two
flags, both `False` by default (`anipose/anipose.py`): `ransac: true` →
`triangulate_ransac` at **2,467 µs/keypoint** (85× the default path, 56× our
refinement); `triangulate` called one keypoint per call → **89 µs/keypoint**. That last
one is the reconciliation for "anipose takes much longer from experience": the huge
numbers are the per-call regime and the ransac/optim flags, not the default solve.

**The optim columns run with `scale_smooth=0`.** aniposelib's defaults smooth across
consecutive frames, but `fig4_input` is stride-15 and then filtered to all-view-complete
keypoints, so its "consecutive" entries are 15+ frames apart — the smoothing term would
penalise real motion as noise and the column would measure our sampling. With it on,
Anipose's optimiser is worse than its own linear solve in 50/50 sessions (2.270 /
3.158). Both variants are deposited (`fig4e_anipose_optim_accuracy.csv`).

**Anipose's linear DLT beats both of ours out of sample.** The mechanism is the
coordinate frame the DLT is written in, not the algorithm: LUC3D undistorts back to
**pixels** and builds its system from K[R|t]; aniposelib undistorts to **normalised**
coordinates and builds its system from [R|t]. That is Hartley normalisation, the
textbook conditioning fix. Reproduced both ways on the same 4,000 keypoints — pixel
frame recovers LUC3D (median 3D separation 4.0e-6 units, 1.6802 px), normalised frame
recovers Anipose exactly (0.0, 1.6697 px). **`triangulatePointDLT` could adopt it and
should not, yet**: that function is on every path (tracker, Triangulate All, save), so
it needs an old-vs-new pinning test on real + random + degenerate inputs and a decision
first. Nothing in the app has been changed.

**The control that makes any of this a comparison** is `fig4_metric_check.mjs`: the
Anipose arm scores with `cv2.projectPoints`, the LUC3D arms with `pose-data.js`'s
`distortPoint`, and the gaps being reported are 0.07–0.22 px. It dumps LUC3D's own DLT
solutions and re-scores those same 3D points with cv2 — median |cv2 − JS| = **4.2e-14
px** (20,000 all-view) and **8.7e-14 px** (100,000 held-out). Same metric to float64
rounding. Re-run it if either distortion implementation is ever touched.

Timing is the **solve alone** in all three bars: `CameraGroup.triangulate` undistorts
inside the call and LUC3D outside it, so Anipose is timed with `undistort=False` on
pre-undistorted points (the excluded cost is 0.57 µs Anipose, 1.16 µs LUC3D, both
deposited). Anipose 29.0 µs/keypoint against our DLT's 6.3 and our refinement's 44.0.
`fig4_anipose.py` also re-times **both** LUC3D solvers in its own sitting via
`fig4_time_luc3d.mjs` and warns if they drift more than `--tol` from `fig4.json`
(4% and 11% at the values plotted), so the three bars cannot silently become a
comparison of two machine loads.

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
explains it: **the reference's OWN native-space reprojection error is 2.40 px
(median over all 50 sessions; it was 1.88 px on the single session this was first measured
on), higher than both DLT and the refined solver.** One quantity, four values had
crept into the repo (2.0 in CAPTIONS.md, 1.92 in `fig4.py`'s docstring, 1.922 here,
1.884 p50 / 2.099 mean in `fig4.json`). **Standardised on `fig4.json`
`reference_reproj_px.p50`, always named as a median.** That value is now **2.40 px**
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
robust loss at all: only a small minority of keypoints have any view off by even 10 px (268,426 of 17,013,412, 1.6%, at >= 10 px on the all-sessions run), versus
the 60 px gross outliers the branch's tests inject.

`figs/fig4_hooks.mjs` exists because that branch's own `scripts/bench/hooks.mjs`
lacks a `getDefaultTriangulationMethod` export that its `pose/triangulation.js` now
imports — which also means **`scripts/bench/bench_crossview.mjs` is currently broken
on `eric/bundle-adj`**. Worth fixing there; our hooks are a local workaround so that
branch is untouched.

### Fig 4b — error vs contributing views, BOTH solvers (`fig4_by_views.mjs`)

Was DLT-only and read `fig2.json`. It now reads **`fig4_by_views.json`**, because a
refinement curve from one run overlaid on a DLT curve from another is not a comparison.
`fig4_by_views.mjs` runs the **real branch solvers** over Fig 4's own input (**stride 15
= EVERY keypoint of the stride-15 export, 17,013,412 keypoints, 884.7 M solves**, 36 min
across 12 shards — it was every 4th keypoint of a stride-60 export, i.e. effective
stride 240, 1,063,427 keypoints, 55.3 M solves), with fig2's exact protocol: every C-choose-k camera subset, 3D distance to the
proofread reference, mm via each session's own `mm_per_unit`.

| k views | DLT | refined | refined/DLT |
|---|---|---|---|
| 2 | 4.738 mm | 4.847 | 1.02× |
| 3 | 2.890 | 3.197 | 1.11× |
| 4 | 1.909 | 2.359 | 1.24× |
| 5 | **1.195** | 1.861 | **1.56×** |
| span 2→5 | **4.0×** | 2.6× | |

**Its DLT arm reproduces `fig2.json` to 0.0–1.1% at every k** (4.732→4.738, 2.890→2.890,
1.916→1.909, 1.207→1.195; against the fig2 run current on 2026-08-12) — the script prints that cross-check, and it is what licenses
calling this the same measurement Fig 2 made rather than a different one. The superseded
12-session run's 4.12 / 2.63 / 1.83 / 1.24 figures are stale; do not quote them.

**The rising ratio is the metric, not the solver, and that is the panel's real content.**
The reference's own reprojection error (2.404 px) exceeds both solvers' (2.245 / 2.056)
and it came from a linear-triangulation pipeline, so distance-to-it rewards agreeing with
a DLT — and one candidate *is* a DLT. refined/DLT climbing monotonically 1.02× → 1.54×
as views increase is the signature: a real accuracy deficit would not scale with how
much information the solver was given, but a distance-from-the-DLT penalty does, because
more views give the refinement more room to move off the seed. Comparing a solver against
**itself** across k is unaffected (the bias is ~constant in k and cancels), which is why
both spans are quotable. **For which solver is better, cite panel d's held-out group.**

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
| `fig6_detections.json` | **74** | **1–7** (12/13/9/13/10/4/13) | — | the benchmark's shared identity-stripped **raw detections** vs the proofread 3D reprojected into each camera, at **stride 1 — every frame, 187,134,382 keypoint comparisons**. **This is what panels c, d and f read.** |
| `fig6_difficulty.json` | 42 | 2–7 (13 at 7, 10 each at 2 and 4) | black 23 / white 19 | **proofread labels** vs the same reference — i.e. the reconstruction's own 2D→3D residual. Legacy called this a "circular comparison" and used it only as a fallback. |
| `fig3_trackers.json slap2m.by_bedding` | 74 | — | black 44 / white 30 | tracker IDF1 by bedding. **This is what Fig 7b reads.** |

The two 74-session tables disagree on the 2-animal miss rate by ~50 % (21.95 % vs
33.16 %) and that gap is a **result**, not an inconsistency to reconcile: the raw
detector misses far more than the residual path suggests, which is what you expect when
the residual path cannot see a detection that never fired. `fig6_07_animal_count.py`'s
docstring records the reasoning for reading `fig6_detections.json`.

Both `_multi_master.tsv` fields the original plan wanted — `obstacle_rating` 0–5 and the
coat-colour counts — are still unused by any panel.

`fig6_measure.py` / `fig6_pose.py` are kept for the corpus totals (130 sessions,
12,039,174 frames, 29.5 h) which are still wanted for the text; `legacy/fig6.py`'s panel
layout is superseded.

## Fig 8 — the rest of the tracker's parameters (EXPLORATORY, NOT IN THE MANUSCRIPT)

**Figure 8 is not part of the paper.** It has no entry in `FIGURE-LEGENDS.md`,
`METHODS.md`, `RESULTS.md` or `CAPTIONS.md`, no panel of Figures 1–7 refers to it,
and nothing was renumbered to make room. It exists to answer one internal question:
Fig 3e swept `corr2dWeight` × `corr3dWeight` and held every other tracker threshold
at its default — do any of the others matter?

`fig8_param_sweeps.py` sweeps the remaining ten one at a time (35 cells) on exactly
Fig 3e's measurement: the same 8 BMimica sessions at full length, the same shared
detections, the same `fig3_score.py`, and the same measured 7,205,370-camera-frame
denominator, so every rate below is directly comparable to a Fig 3e rate. The
shipped-default cell is Fig 3e's own `corr2d=1/corr3d=6` run, reused by symlink
rather than re-measured ten times.

**Seven of the ten sweeps produced BYTE-IDENTICAL tracker output at every value**, and
that is deliberately measured rather than argued: the deposit records the SHA-256 of
each run's `identities`+`frames` payload and compares it to the default's on all 8
sessions. Three quite different things are hiding behind those flat lines.

| | thresholds | why flat |
|---|---|---|
| **never read** | `track3dWeight`, `prevIdentityBonus`, `minMatchScore`, `reprojSigma`, `epipolarDecay` | `runCrossViewTracker` does not read them at all — see below |
| **read, never decisive** | `velocityThreshold` (2 → 40) | it normalises the 2D term, which saturates in normalised image units; the 3D term decides matches. A genuine null. |
| **not exercisable** | `filterMinInstanceScore` (0 → 0.85) | the filter gates on `inst.score != null` and the BMimica `{cam}_predictions.h5` pool holds a `tracks` dataset and nothing else. **Uninformative, not negative.** |

**`runCrossViewTracker` — the function `trackAll()` calls — reads exactly seven
thresholds**: `corr2dWeight`, `corr3dWeight`, `velocityThreshold`,
`distanceThreshold`, `timePenalty` (via `crossViewHyperparams()`, `pose/tracker.js`
l.840) and `filterMinVisibleNodes`, `filterMinInstanceScore` (via
`buildTrackerDetections()`, l.853–855). The other five are read only inside
`matchFrameInstances` and its helpers — **the legacy bench-only matcher**, whose only
call sites in the repo are `scripts/bench/bench_driver.mjs`,
`scripts/bench/speed_test.mjs` and `tests/test-tracker-luc3d.mjs`. This is the
`matchFrameInstances`-is-not-the-app's-tracker trap again, and `track3dWeight` is
where it bites: `ui/settings.js` describes it as the temporal identity-linking weight
that "suppresses sustained ID swaps" and names **6 ≈ the benchmark champion** against
a shipped **1** — and on the shipped path it does nothing at any value. **Either the
description should say it is inert outside the legacy bench matcher, or the tracker
should start reading it.** Same for the `filterMinVisibleNodes` description's "the
sleap-3d reference used 8", which is byte-identical to 0 on this detector's output.

Only three thresholds moved a single assignment, and the default is at the best
sampled value for only one of them (rates per 100,000 camera-frames):

| threshold | shipped | rate at shipped | best sampled | rate there | cross-view IDF1 |
|---|---|---|---|---|---|
| `distanceThreshold` | 50 | 4.497 | **25** | **3.636** | 0.735 → **0.795** ⚠ (see 8e) |
| `corr3dWeight` | 6 | 4.497 | 12–36 (flat) | 3.78 | 0.735 → 0.766 |
| `filterMinVisibleNodes` | 0 | 4.497 | 0 (= 4 = 8) | 4.497 | 12 is **worse**: 5.08, IDF1 0.685 |

`distanceThreshold = 25` has **fewer switches in 4 of 8 sessions and more in none**,
and its IDF1 gain (+0.060) is more than twice the ±0.027 band Fig 8b draws — a band
itself measured from Fig 3e's own plateau (six near-replicate cells whose IDF1 still
spreads 0.707–0.762 while the switch rate does not move). That band is the reason 8b
exists as a separate panel rather than a twin axis on 8a: the switch rate resolves a
factor of 150 in Fig 3e and IDF1 here resolves almost nothing.

**The `corr3dWeight` tail is flat, which is what 18 and 36 were run to test**: 12 →
3.78, 18 → 3.91, 36 → 3.78. Nothing past Fig 3e's r = 12.

**`distanceThreshold` and `corr3dWeight` are two knobs on the SAME term** —
`w_k·corr3d·(1 − dist/distThresh)` — and they improve the same sessions, so the 1-D
sweeps cannot say whether one buys anything over the other. `fig8_param_sweeps.py
--interaction` measured it (deposit key `interaction_check`, deliberately not
plotted): they **partially stack**. `dt=25, corr3d=36` is the best configuration
found — **3.497 per 100,000 and IDF1 0.818**, against the shipped 4.497 / 0.735 —
better in 4 of 8 sessions and worse in none.

**Before changing any shipped default**, note the standing caveats: one rig, one
detector, two animals, five cameras; `distanceThreshold` is in world units (mm) and
`velocityThreshold` in normalised image units, so both are tied to this geometry;
and 4-of-8-better/4-tied is a small n by this repo's own standards (see the Fig 4
sections on how badly single-run and small-n conclusions have travelled here).

### Fig 8c/8d — what an ALGORITHM change buys, once you know what the loss is made of

8a/8b answer "do the constants matter". 8c and 8d answer what follows. Same 8 BMimica
sessions, same full length, same detections, same `fig3_score.py`, same 7,205,370-camera-
frame denominator, so every number here is comparable to a Fig 3e or Fig 8a/8b number.
`fig8_methods.py` drives `figs/fig8-bench/fig8_bench.mjs`, which serves
`figs/fig8-bench/xv_experimental.js` in place of `pose/cross-view-tracker.js` through an
ESM loader hook. **No app source is modified** — the shipped tracker file is read, never
written, per the figs "no app-source edits" rule.

**The fork is proved honest before anything is read off it.** With an EMPTY method block
it is **byte-identical to the shipped tracker on all 8 full sessions** — same SHA-256 of
the `identities`+`frames` payload that 8a used to prove five thresholds inert
(`out/fig8_methods_verify.json`, `fig8_methods.py --verify`). So any row below is the
method's difference, not the fork's.

**8c: 98.6% of the recoverable loss is IDENTITY, not coverage.** Relabelling every
detection to the id of its best-IoU GT box (`fig8_diag_loss.py`, full sessions):

| | mean cross-view IDF1 |
|---|---|
| shipped | 0.7347 |
| + perfect identities at today's coverage | **0.9367** |
| + perfect coverage too | 0.9395 |

99.4% of detections with a bbox already get an identity, so `commitTrackedFrame`'s
">= 2 views" rule costs almost nothing. **Quote 0.9367 as the ceiling, not 1.0** — and
note two of the eight sessions already sit ON it.

**The swaps are rare and PERMANENT, not frequent.** 324 within-view switches across 7.2M
camera-frames, yet IDF1 0.735. 20250904_131913 loses **0.311 IDF1 to TEN switches**. The
same tracker scores **0.935 over the leading 20,000 frames** of each session and 0.735
over the full ~180,000. Two consequences: optimising switch count is optimising a number
that is already tiny, and **a windowed experiment cannot see this failure at all**.

**8d: the winner is anchor freshness, and it was not one of the three methods this
started with.** `Target.detsByCam` keeps one detection per camera and **never expires
it**, and `_retriangulate()` fuses all of them — so the 3D state every association is
scored against blends the current pose with wherever each other camera last saw the
animal. `fig8_diag_anchor_age.py` measures it (behaviour-neutral, verified by digest):
mean detection age **3.0–49.8 frames** by session, maxima **844–8,652 frames**. Faithful
to the sleap-3d reference, which has no track aging.

"Headroom" below is the fraction of 8c's 0.202 identity gap that the configuration
closes. "Worst" columns are the largest single-session harm against shipped — the number
that decides shippability here, because two sessions are already at their ceiling.

| configuration | switches | per 100k | cross-view IDF1 | headroom | better/worse | worst IDF1 | worst sw |
|---|---|---|---|---|---|---|---|
| shipped | 324 | 4.497 | 0.7347 | — | — | — | — |
| best pure-threshold (`dt=25`, `corr3d=36`, 8a/8b) | 252 | 3.497 | 0.8185 | 41.5% | 4 / 1 | −0.023 | +0 |
| `sync` alone | 296 | 4.108 | 0.7620 | 13.5% | 2 / 2 | −0.040 | +20 |
| `stale: 1` alone | 150 | 2.082 | 0.8042 | 34.4% | 6 / 1 | −0.319 | +18 |
| `sync` + `stale: 1` | 118 | 1.638 | 0.8341 | 49.2% | 6 / 1 | −0.068 | +18 |
| **`sync` + `stale: 10` + `dt=25`** | **64** | **0.888** | 0.8581 | 61.1% | 5 / 1 | **−0.040** | **+0** |
| **`sync` + `stale: 1` + `dt=25`** | 108 | 1.499 | **0.8745** | **69.2%** | 6 / 1 | −0.068 | +18 |

**Two finalists, and the horizon is the choice between them.** `stale: 1` reaches the
highest IDF1 (0.8745, 69% of headroom) but pays +18 switches on 20250827_141755, a session
that was sitting exactly on its own ceiling. `stale: 10` leaves that session alone (its
mean anchor age is 4.5 frames — it never had a staleness problem), gives up 0.016 IDF1,
which is INSIDE the ±0.027 band, and in exchange reaches **64 switches, an 80% reduction
against shipped, with no session gaining a single switch**. On the evidence available
`stale: 10` is the better engineering choice and `stale: 1` the better headline; the
0.016 between them is not resolvable by this measurement.

Adding `corr3d=36` on top of `stale: 1 + dt=25` changes nothing (0.87452 either way),
which is 8a/8b's "`distanceThreshold` and `corr3dWeight` are one knob" showing up again.

**The gain is not bought with coverage.** Re-running 8c's decomposition on `sync` +
`stale: 1` gives an assignment rate of 0.9944 — identical to shipped to four places — and
an unchanged oracle ceiling of 0.9367, with the identity gap falling 0.2020 → 0.1027. So
it removed **49% of the identity error** while emitting exactly as much output.

**The controls are what make it a mechanism rather than a lucky cell.** Every method here
changes how fresh the scored-against state is, and the ordering is monotone over four
orders of magnitude: `stale: 1` 108–118 switches, shipped 324, `anchorSmooth` 0.1 → 2,800,
freezing the anchor on near-tie frames → 1,700 at margin 100 and **27,042** at margin 400.
Fresher better, staler worse, every step.

**Three initial premises were refuted by measurement, and those are the reusable part:**

| premise | verdict |
|---|---|
| the swap is a within-frame cascade (per-camera Hungarian re-triangulating on each match) | **partly** — `sync` fixes it for +0.027/−28, but its pooled gain is carried by ONE of eight sessions |
| the swap is a cross-view-inconsistent labelling | **no** — `xvRefine` (offer each view's detection to another target, keep it if total triangulation residual falls) accepted **0 and 5 exchanges out of ~170,000 tests**. All five views swap TOGETHER and the triangulation stays tight |
| a skeletal descriptor can re-identify the animals | **no** — frozen prototype, P(closer to its own animal) = **0.40–0.57** over 8 full sessions, i.e. chance. Block means separate them in 2 of 8 pairings |

**The re-id trap is worth recording.** An early probe read P = 0.908 (3.2 mm to its own
animal vs 7.7 mm to the other) and that was an artefact of a **live EMA prototype**: at
`reidEma` 0.01 the prototype is roughly "this target 100 frames ago", so it measured the
descriptor's autocorrelation, not identity. Only a frozen prototype can survive a swap,
and that is the one that collapses to chance.

**`bundle` — the most respectable method here — was 70x worse** (22,882 switches). It
grouped detections across views by pairwise epipolar error before associating, which is
the standard multi-view MOT shape, but pairwise epipolar error is a far weaker cue than
agreement with a 5-view 3D state, so the grouping flickered and took the identities with
it. Not "grouping-then-associating is wrong"; "this grouping threw away the strong cue".

**Two other identity signals are ruled out for this corpus without new code.** Per-camera
`trackIdx` continuity: Fig 3's tracker comparison puts SLEAP's own per-camera tracker at
within-view IDF1 **0.115** on BMimica. Pixel appearance: the `{cam}_predictions.h5`
detection pool holds a `tracks` keypoint dataset and no images, so a real appearance
re-id model has no input on this measurement.

**The rest of the method inventory, all negative, all measured rather than assumed.**
Every flag implemented in `xv_experimental.js` was put through the full 8-session pass,
including the ones expected to fail — otherwise they would be asserted, not measured:

| method | result | reading |
|---|---|---|
| M6 robust per-node aggregation (25% trimmed mean instead of the shipped sum) | 286–318 switches, IDF1 0.750–0.763 | consistently WORSE than the same configuration without it (`dist25` 262/0.795 → `dist25_robust25` 318/0.763). The sum's outlier sensitivity is apparently doing useful work, not harm |
| OC-SORT-style 15-frame velocity baseline | 230 switches / 0.8147 on the threshold bar | better than the naive 1-frame version (344/0.746) and roughly neutral against no motion model at all (252/0.8185). The 1-frame baseline was the bug; a motion model is simply not the lever |
| M3 re-id, frozen prototype (the variant the probe said to test) | 23,108–25,331 switches, IDF1 0.711–0.769 | exactly what a chance-level descriptor predicts |
| `sync` on the threshold bar | 220 switches / 0.8212 | a genuine small gain over 252/0.8185, consistent with M1 elsewhere |
| M3′ prototype-driven identity EXCHANGE (permute the labels, leave the geometry alone) | 572 switches / 0.7638 | the better-posed form of re-id, and still dead: it applied **31 exchanges** across 8 full sessions, and its own audit shows "keep" at 13.23 mm against "exchange" at 12.21 mm. That 1.02 mm is the Hungarian-minimum bias — the exchange cost is a minimum so it is *always* ≤ the diagonal — not evidence. Each exchange cost switches and bought nothing |
| `gateAdj` = 0 (refuse negative-adjacency matches, let the target coast) | 1,223 switches / **0.3401** | catastrophic, and predictably: with `maxTargets` = 2 and two targets alive, `_initializeTargets` returns immediately, so a refused detection is simply DROPPED. It buys identity purity with the coverage 8c says there is only 0.003 of to spend |

So of the method families tried, **one worked** (anchor freshness), **one helped
marginally** (`sync`), and **six did not**. The failures are what localise the fault, and
between them they rule out cross-view grouping, cross-view consistency, motion modelling,
robust aggregation, ambiguity gating, coverage gating, and both formulations of re-id.

**One bug was found this way, and the numbers were re-measured.** The `motionBase` ring
buffer stamped each history entry with the CURRENT frame instead of `_lastFrame`, which at
`motionBase` = 1 made `dtPrev` zero, tripped `_stateFor`'s `dtPrev > 0` guard, and left the
constant-velocity model **silently inert** — `sync_motion` was quietly running as plain
`sync`. `--recheck` caught it; the three motion cells were re-tracked and re-scored after
the fix. `sync_motion` came back at 344 switches / 0.7458702406650748, matching its
pre-existing round-1 measurement to all sixteen digits, which is what confirms the fix
RESTORED the original semantics rather than merely changing them. The practical damage was
an off-by-one in the 15-frame baseline (14 frames, not 15) worth 2 switches: `230/0.8147`
after the fix against `228/0.8147` before. No conclusion moves — a motion model is still
not the lever.

**Cache integrity is checked, not assumed.** The per-cell tracker cache is what makes this
restartable, and it outlived many tracker edits across nine rounds — `motionBase`,
`_ambigCams`/`_retriangulate(exclude)`, `robustTrim`, `anchorSmooth` and `probeAge` were
all added after some cells were already cached. `fig8_methods.py --recheck` re-tracks one
session per cached cell under today's code and compares the same digest `--verify` uses,
so "the deposit does not mix code versions" is a measurement
(`out/fig8_methods_recheck.json`). Five `ambigMargin`-on-a-stronger-baseline cells whose
provenance straddled that fix were quarantined to `out/tmp/fig8m_quarantine/` rather than
reported, since `ambigMargin` had already been measured at three margins on the `sync`
substrate and is decisively harmful.

**Before changing any shipped default**, the standing caveats from 8a/8b all apply — one
rig, one detector, two animals, five cameras, and `distanceThreshold` in world units so it
is tied to this geometry — plus three specific to this result:

* **Every configuration still harms one session.** `stale: 1` costs 20250827_141755
  0.0675 IDF1 and +18 switches; `stale: 10` costs 20250905_165151 0.0404. Neither is free,
  and this repo's history with identity fixes is that clean sessions pay.
* **n = 8, and the pooled mean is carried by a few sessions.** `stale: 1 + dt=25` gains
  +0.29 and +0.31 on two sessions; strike those and the mean advantage over the best
  threshold setting largely goes. Against `dist25_corr36` specifically it is better on 3
  sessions, worse on 3 and tied on 2 — a much weaker statement than the pooled 0.8745 vs
  0.8185 suggests.
* **`stale` is a change to `Target.detsByCam` lifetime, not a threshold.** It is a real
  code change to a shipped path, and the app's Track All has no way to express it. Adding
  it as an eleventh threshold would also need an `ACTION_CATALOG`-style decision about
  whether users see it (see CLAUDE.md's maintenance rules) and a `MODULES.md` update.

### WHICH PANELS ARE ON WHICH CORPUS — read this before quoting any Fig 8 number

| panel | sessions | status |
|---|---|---|
| 8a, 8b — threshold sweeps (35 cells) | **8** | its headline is **contradicted** by 8e; see the correction below |
| 8c — loss decomposition / oracle ceiling | **8** | mechanism, not a ranking; not re-run at 50 |
| 8d — algorithmic methods (24 cells) | **8** | the *negative* results are decisive at 8; the two winners are re-run at 50 in 8e |
| **8e — the two candidates + the bar** | **50** | the pass that decides the recommendation |

Fig 8 is therefore **not wholly a 50-session figure**. Only the four configurations in 8e
were re-measured on the full corpus, chosen because they are the ones a shipped-default
decision turns on. Re-running 8a/8b at 50 sessions would be 35 cells x 50 sessions and
8d's full grid another 24 x 50 — hours of tracking plus hours of motmetrics — and the
methods that failed at 8 sessions failed by one to two ORDERS OF MAGNITUDE (`bundle` 70x
worse, `ambigMargin` up to 83x worse), which no corpus change plausibly reverses. The
thresholds are the ones that would repay it, precisely because 8e shows their 8-session
gain was mostly subset noise.

### Fig 8e — ALL 50 BMimica sessions, which corrected two of the conclusions above

Everything from 8a to 8d is measured on Fig 3e's 8 sessions. `fig8_methods.py
--all-sessions` re-ran the control, the best pure-threshold setting and both candidates
over **all 50 proofread BMimica sessions** at full length — 45,021,960 camera-frames, with
sessions PAIRED across configurations. Report: `$PY figs/fig8_report50.py`.

**The harness validated exactly, before anything was read off it.** `fig3_trackers.json`
already holds an independent 50-session measurement of the shipped tracker through a
different pipeline. This pass reproduced it to every digit: cross-view IDF1
**0.7492538449691502** here against **0.7492538449691503** there, within-view
0.7493820567067009 against 0.7493820567067009, and **2,071 switches against 2,071**. Two
independent pipelines agreeing bit for bit is the strongest available statement that these
50-session numbers are real.

| configuration | switches | per 100k | mean | median | q25 | q75 | better / worse | worst session |
|---|---|---|---|---|---|---|---|---|
| shipped | 2,071 | 4.600 | 0.7493 | 0.7604 | 0.609 | 0.832 | — | — |
| best thresholds (`dt25`+`corr3d36`) | 1,841 | 4.089 | 0.7615 | 0.7595 | 0.665 | 0.923 | 14 / 11 | **−0.275** |
| `M1 + stale 1 + dt25` | 677 | 1.504 | 0.8393 | 0.8807 | 0.728 | 0.934 | 31 / 9 | −0.215 |
| **`M1 + stale 10 + dt25`** | **511** | **1.135** | **0.8498** | **0.9127** | 0.746 | 0.947 | **32 / 6** | **−0.138** |

Paired Wilcoxon signed-rank on the per-session IDF1 differences:

| comparison | median diff | better / worse | p |
|---|---|---|---|
| `stale 10 + dt25` vs shipped | **+0.0777** | 32 / 6 | **1.7e-06** |
| `stale 1 + dt25` vs shipped | +0.0757 | 31 / 9 | 8.3e-05 |
| `stale 10 + dt25` vs best thresholds | +0.0777 | 28 / 8 | 2.7e-05 |
| `stale 1 + dt25` vs best thresholds | +0.0327 | 26 / 10 | 7.2e-05 |
| `stale 10` vs `stale 1` | +0.0000 | 12 / 16 | 0.8 |

**TWO CONCLUSIONS ABOVE MUST BE CORRECTED, in opposite directions.**

1. **The pure-threshold result largely does NOT survive.** On 8 sessions `dt25 + corr3d36`
   looked like +0.084 IDF1 (0.7347 → 0.8185). On 50 it is **+0.012 on the mean and −0.001
   on the median** — 14 sessions better, 11 worse, one damaged by 0.275. This is exactly
   the subset reversal this file warns about for Fig 4, arriving this time for Fig 8's own
   headline. **`distanceThreshold` 25 (+ `corr3dWeight` 36) must not be presented as a
   recommendation on the strength of 8a/8b alone.**
2. **The anchor-freshness result DOES survive, and strengthens.** 2,071 → **511** switches
   (**−75%**), mean IDF1 +0.101, **median +0.152** (0.7604 → 0.9127), better on 32 of 50
   sessions and worse on 6, p = 1.7e-06 paired. It beats the best threshold setting by a
   median +0.078 at p = 2.7e-05.
3. **The 8-session ordering of the two candidates REVERSED.** On 8 sessions `stale: 1` led
   (0.8745 vs 0.8581); on 50 `stale: 10` leads (0.8498 vs 0.8393) — and the two are
   statistically indistinguishable from each other (median diff 0.0000, p = 0.8). So the
   8-session preference for `stale: 1` was noise, while every robustness measure already
   favoured `stale: 10`: fewer switches (511 vs 677), fewer damaged sessions (6 vs 9),
   smaller worst-case harm (−0.138 vs −0.215). **`stale: 10` is the recommendation.**

**It is still not free.** Six of 50 sessions get worse, the worst by 0.138
(`20250829_141847`, 0.7173 → 0.5793 — though its switches fall 88 → 36, so that loss is
mislabelled mass, not churn). Any rollout should quote the per-session table, not the mean.

`assemble.py 8` now reports **516 mm, over the 200 mm ceiling** — four stacked full-width
rows cannot fit one page and the assembler flags it rather than silently scaling. Fig 8 is
an internal figure and the per-panel PDFs are the artefact that matters (see the top of
this file), so the composite is left as a tall proof sheet. If Fig 8 ever needs to be one
page, split the thresholds (8a/8b) from the methods (8c/8d) into two figures rather than
shrinking panels below the 5 pt floor `lint_text.py` enforces. Reproduce all of it with:

```bash
$PY figs/fig8_methods.py --verify      # prove the fork == the shipped tracker
$PY figs/fig8_diag_loss.py --cell default            # 8c
$PY figs/fig8_diag_anchor_age.py                     # the anchor-age mechanism
$PY figs/fig8_methods.py                             # all method cells (hours)
python3 figs/panels/fig8_03_loss_budget.py figs/panels/fig8_04_methods.py
```

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
figure's honest headline. **On all 50 sessions and 3 calibrations (17,013,412 keypoints at
stride 15) the sign flips**: held-out median DLT **3.051** px against refined **2.971** px,
so the refinement is better out of sample — but only just, and the effect is negligible:

* median paired difference **0.058 px**, a 2.6% reduction;
* refined wins on **53.1%** of individual held-out keypoints (45,197,705 of 85,067,060) —
  barely above a coin flip;
* refined lower in **34 of 50** sessions.

So neither of the two clean stories is true. It is not "the refinement does not
generalise" (n = 1 artefact, wrong sign) and not "the refinement improves accuracy"
(0.08 px is far below the reference's own 2.40 px error). The defensible statement is
**detectable but negligible out of sample**, which is why Fig 4 now leads with view count
(4.7 -> 1.2 mm, 3.9x) and outlier rejection (up to 7.2 mm) instead of with the solver
comparison.

This is the second time a single-session Fig 4 number misled a conclusion in this figure
set. Treat any n = 1 result here as a pilot, never as a finding.

Other numbers that moved with the full run:
* **pre-#113 regression rate: 24.7%** (4,193,925 / 17,013,412), not the 35% (12-session) or
  39% (single-session) previously quoted.
* **Median lens-distortion displacement: 8.41 px** (p95 23.34, n = 85,067,060 — every
  detection in every view, no longer a 1-in-85 sample),
  now actually deposited in `fig4.json distortion_px`. The earlier 4.6 px was
  `console.log`-only and the 7.1 px in this README was from a superseded run.
* **Reference 3D's own reprojection error: 2.40 px median** (mean 2.73), up from 1.88 px.

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
  error (median reprojection 2.40 px, above either candidate solver's -- the same reason
  Fig 4 makes no 3D comparison between solvers);
* the on-artwork label is now "comparison floor", not "alignment floor", and the axis reads
  "3D error vs proofread (mm)" so it cannot be mistaken for a reprojection error.

The claim that Fig 4b's 3.9x is a lower bound *because alignment error inflates the
denominator* was withdrawn with the same reasoning. It may still be a lower bound, since
the denominator includes detector and proofreading error, but not for the stated reason.

### Fig 7 c-g now plot the tracker LUCID actually ships (2026-08-13)

On instruction. Panels **c, d, e, f, g** took their LUC3D arm from
`out/fig3_trackers.json`'s `slap2m` block, which was produced by `matchFrameInstances` —
the **pre-#131 per-frame matcher** — against a flat LUCID snapshot on 2026-05-15.
`pose/cross-view-tracker.js` (`runCrossViewTracker`) was merged **2026-07-06**, seven weeks
later, so those five panels described a tracker the app no longer contained. They now read
`out/fig7_variant_best.json`'s `slap2m` block, which is the shipped tracker re-scored over
the **same 74 sessions, same pool, same detections** (detector recall 0.7285 vs 0.7268 — it
has to be the same detections, and it is). `fig3_trackers.json` is **not** rewritten; the
panels changed which deposit they read, and it stays git-clean.

The substitution is a **drop-in**: the two `slap2m` blocks were compared key for key,
nested, and neither side has a key the other lacks — no panel needed a new code path.
`--as-shipped` re-renders the retired arm under a `_pre131` slug and was verified to
reproduce each committed panel **pixel for pixel at 150 dpi** (max channel difference 0 on
all five), so the old artwork is recoverable and the only thing that moved is the data.

| panel | quantity | pre-#131 | shipped |
|---|---|---|---|
| c | within-view IDF1, mean / median | 0.736 / 0.900 | **0.752 / 0.920** |
| c | sessions ≥ 0.9 · camera-sessions won | 36/74 · 229/444 | **39/74 · 269/444** |
| d | paired Δ vs SLEAP, all 74 | +0.075 (48/74) | **+0.091 (55/74)** |
| d | paired Δ, 3 animals (n = 4) / 4 animals (n = 3) | −0.030 / −0.028 | **−0.052 / −0.080** |
| e | ID switches | 3,710 (0.0316%) | **3,094 (0.0264%)** |
| e | false positives | 34,240 (0.292%) | **37,126 (0.317%)** |
| f | r(session IDF1, detector recall) | 0.9747 | **0.9900** |
| g | paired fragmentations vs SLEAP | +24.0, median +14.1 | **+6.2, median +1.3** |

**Three of this figure's own claims moved, and two of them moved in our favour** — which is
exactly why each one is written into its panel's docstring rather than quietly absorbed:

* **7e's "LUC3D does not win on within-view switches" is now false** (3,094 against SLEAP's
  unchanged 3,608, 14% ahead) and the note is gone. But the **false-positive term went the
  other way**, +8.4%, and FP bars are ~12x the switch bars on that panel, so the term we
  lost on is the one the eye lands on first. That emphasis is correct and is not to be
  "fixed".
* **7d's "the pooled gain is carried by the 1-animal stratum" weakened.** Pooled over the 42
  sessions with ≥ 2 animals it was +0.024 (23/42, sign P = 0.64, no effect) and is now
  +0.052 (30/42, **P = 0.008**). The 1-animal caveat stays — that cell is still 2.7x the
  ≥ 2 one and still not a cross-view result — but the panel's own split now supports a
  weaker claim than it was built to make, and the artwork line "carried by the 1-animal
  stratum, NOT a multi-animal result" was replaced with the two numbers.
* **7g's +24.0 was a property of the retired tracker**; the shipped one is +6.2. The sign,
  the CI excluding zero and "SLEAP fragments fewer in 72 of 74" all hold, so the panel
  stands — but its mean is now **4.7x its median** (it was 1.7x), so the corpus mean is a
  tail and the typical session is nearly level. The `caveats` string in
  `fig3_trackers.json` still quotes +24.0 and must not be cited for this panel.

**7d is still the panel this costs us**, and it is untouched by the flattering corrections:
the shipped tracker emits **3.6x and 2.0x more** within-view switches than the retired one
on the 3- and 4-animal sessions (205 → 744, 299 → 606) and scores lower there, worst session
−0.103 → **−0.152**. n = 4 and n = 3: weak, reproducible, never to be averaged away.

**7b (bedding) WAS NOT IN THE INSTRUCTION and is still on the pre-#131 arm**
(`arms(variant, corrected=False)`). Until it is switched, one figure carries two tracker
generations under the name "LUC3D" — b is the old one, c-g are the shipped one. It is one
keyword away and it needs a decision, not an inference. **7a** is BMimica and always was
`runCrossViewTracker`.

`FIGURE-LEGENDS.md` was updated for c, d, f and g (e's legend quotes no tracker number).
Lint is back at its two pre-existing issues; three clipping/overlap defects surfaced in the
`--variant` renders while re-rendering and were fixed there too.
