#!/usr/bin/env python3
"""
Fig 3d -- 3D-term ablation: ID-switch RATE and cross-view IDF1 against r = corr3d/corr2d,
now over ALL 50 proofread Mouse-Dyad-10M sessions and BOTH tracker states.

UPDATED 2026-08 (on instruction): the manuscript panel now draws TWO ARMS -- the
SHIPPED tracker and the FRESH-ANCHOR configuration (`sync` + `stale 20` +
`distanceThreshold 25`, corr3dWeight still swept) -- over the full 50-session corpus.
Two reasons, both measured rather than aesthetic:

  1. THE 8-SESSION PLATEAU WAS A SUBSET RESULT. The committed panel found the switch
     rate flat past r = 4 on 8 sessions; this repo's own history (Fig 4, Fig 8a/8b)
     records two conclusions that REVERSED between 8 and 50 sessions. The 50-session
     grid is the measurement the claim needs.
  2. THE PLATEAU ITSELF WAS A PROPERTY OF THE STALE ANCHOR. With the anchor fresh the
     corr3d tail is NOT flat (Fig 3g first showed this on 4 cells; this panel now
     carries the full 12-ratio row): a sweep run against a corrupted state reports the
     state's insensitivity, not the parameter's. Showing the two arms together is what
     makes that visible -- a re-render that silently swapped the arm would hide it.

ONE HUE = ONE METRIC, ARM = FILL. Salmon is the switch rate and teal is cross-view
IDF1, exactly as before; the two ARMS are distinguished by fill and line style
(filled + solid = shipped, hollow + dashed = fresh anchor), the same idiom Fig 3d and
Fig 7's variant panels use for "same tracker, different operating point". A second hue
per arm would read as four metrics.

THE TWO DEPOSITS MUST AGREE ON THE DENOMINATOR, AND THAT IS ASSERTED. `switches` is a
raw sum, so the rate is only comparable across arms because both arms were tracked and
scored over the SAME 50 sessions -- `total_camera_frames` is checked equal and each
cell's `n_sessions` is checked = 50 before anything is drawn. A deposit from the old
8-session pass (7,205,370 camera-frames) can never land on this axis.

SWITCHES ARE A RATE, NOT A SUM (review 2026-08). Per 100,000 camera-frames over the
measured exposure -- 45,021,960 camera-frames, deposited by `fig3_sweep50.py` from the
same HDF5 shapes `fig3_score.score_session()` scores over. The raw sums stay in the
deposited CSV.

THE GRID IS THE corr2d = 1 ROW. The committed 8-session sweep verified that all 24
(corr2d, corr3d) cells collapse exactly onto r = corr3d/corr2d (identical IDF1 and
switches wherever r ties), so the 50-session pass samples each r once. The legacy
panel's collapse check therefore has nothing to compare here; the legacy render
(`--legacy8`) still runs it against the 8-session deposit.

r IS ON A REAL LOG AXIS with the r = 0 control in a broken-off slot to the left --
the machinery, and the reasons for it, are unchanged from the 8-session panel (see
`--legacy8`'s section below).

THE METRIC IS IDF1, NOT HOTA. Nothing in luc3d-bench computes HOTA. Do not relabel.

THE FLAT RULES ARE NOW FRAME-MATCHED, AND THAT MOVED THE IDF1 ONE A LONG WAY.
-----------------------------------------------------------------------------
Until 2026-08-18 the salmon IDF1 rule sat at 0.400, read from
`fig3_exhaustive_bmimica.json`, and that number was a COVERAGE artefact rather than an
association result. Exhaustive only emits a result where every camera holds exactly A
clean detections -- 4,324,469 of 9,004,392 BMimica frames, 48% -- but
`fig3_headtohead.py:361` scored it over the WHOLE session, so every ground-truth
animal on the other 52% was charged to it as an identity miss while greedy was scored
on all of them. Across the 50 sessions corr(coverage, that IDF1) = 0.86, and perfect
association with silence elsewhere caps IDF1 at ~0.64 at this coverage -- below the
teal curve before exhaustive makes a single mistake. `fig3_headtohead.py`'s own caveat
list said as much ("the gap is not a quality difference ... no figure panel plots
them") and this panel plotted them. Eric, 2026-08-18: "is the idf1 score just so low
because we didnt try it on the frames with missing detections?" and then "can we get a
fair estimate for 3d also?"

So both rules now come from `fig3_frame_matched_bmimica.json`
(`figs/fig3_frame_matched.py`), which re-scores BOTH arms over exactly the frames
exhaustive computed -- same stored driver outputs, same GT, same scorer, only the frame
set moves and it moves for both:

    exhaustive   cross IDF1 0.6275 (was 0.400)   17,516 switches   81.01 /100k
    greedy       cross IDF1 0.7906               1,730 switches     8.00 /100k
    (identical 21,622,345 camera-frames; exhaustive higher in 10 of 50 sessions)

TWO RULES, NOT ONE, because a fair number needs its comparator on the same basis. The
grey rule is the head-to-head greedy arm on those same frames; grey is the set's
reference-level ink (7d uses it the same way) and NOT teal, because this is a
different arm at a different operating point from the swept curve -- `greedy.json` is
`fig3_bench.mjs` at DEFAULT thresholds, while the curve sweeps the fresh anchor over r
on the full session. A teal rule would read as a point on that curve.

THE SWITCH RULE DID NOT MOVE, AND THAT IS THE CROSS-CHECK. Exhaustive's switch count
was always tallied on the frames it computed, so frame-matching cannot change it: the
rescore returns 17,516 switches / 81.0088 per 100k against the published deposit's
17,516 / 81.00879. The panel asserts that equality before drawing -- it is the evidence
that this rescore is the same measurement as the published one, differing only where
IDF1's denominator was the problem.

WHAT FRAME-MATCHING DOES NOT FIX. Exhaustive is purely per-frame; its identities exist
only through `fig3_exhaustive.mjs`'s nearest-3D-centroid threading to the previous
COMPUTED frame, which is OUR scaffolding and not the published method. On the matched
frames its IDP, IDR and IDF1 come out equal (a 1:1 detection match to GT with no false
positives and no misses), so the remaining 0.63 vs 0.79 is entirely "did the identity
survive the gap" -- temporal bookkeeping, not association. The threading-free comparison
is the partition agreement, and on these same frames the two methods choose the SAME
partition on 4,324,311 of 4,324,469 (99.996%). That is why the rules stay reference
levels and not a third arm of the sweep.

Source: figs/out/fig3_sweep50.json (shipped arm) and
        figs/out/fig3_sweep50__distanceThreshold25-stale20-sync_*.json (fresh anchor),
        both written by figs/fig3_sweep50.py over the full 12-ratio corr2d = 1 row.

    python3 figs/panels/fig3_05_sweep.py             # the manuscript panel
    python3 figs/panels/fig3_05_sweep.py --legacy8   # the retired 8-session panel


--legacy8: THE RETIRED 8-SESSION SHIPPED-ONLY PANEL
---------------------------------------------------
Renders the pre-update manuscript panel -- 8 sessions, shipped tracker only, from
`figs/out/fig3_sweep.json` -- pixel-identical to the committed artwork, under the
`sweep_legacy8` slug so it can never overwrite the manuscript PDF. Everything below
this line documents that render and is kept verbatim because the machinery (the rate
basis, the log axis, the r = 0 break) is shared:

SWITCHES ARE A RATE, NOT A SUM (review 2026-08). `switches` in the deposit is the
sum of per-camera within-view ID switches over all 5 cameras of all 8 sessions --
40,984 at r = 0 down to 272 -- and a total like that is uninterpretable without the
exposure it accumulated over. The denominator is MEASURED, never assumed: every
session was tracked and scored over its full length, so the exposure is
`sum over camera, session of min(gt_frames, det_frames)` = 7,205,370 camera-frames,
computed by `fig3_sweep.camera_frames()` from the HDF5 shapes (the same expression
`fig3_score.score_session()` scores over) and deposited as
`fig3_sweep.json total_camera_frames`. This panel READS that key and exits if it is
absent -- run `python3 figs/fig3_sweep.py --denominators`, which re-measures only the
frame counts and touches neither the tracker runs nor the scoring.

Per 100,000 camera-frames rather than percent or per 1,000: the range is 569 down to
3.8 per 100,000, which sets on an axis in whole numbers. As percent those are 0.569%
and 0.0038%, and per 1,000 they are 5.69 and 0.0378 -- both axes of leading zeros.
The RAW SUMS stay in the deposited CSV, so nothing is lost.

THE SWEEP IS ONE-DIMENSIONAL AND THIS PANEL SAYS SO. The cost function sums a 2D and
a 3D term, and only their RATIO matters -- all 24 (corr2d, corr3d) cells collapse
exactly onto r = corr3d/corr2d. This is verified here, not assumed: `build_legacy8()`
asserts that every cell sharing an r reports identical IDF1 and identical switches,
and it does (r = 1 gives 0.9518 / 14 switches whether it came from 0.5/0.5 or 1/1).

An earlier version of this panel drew the raw 24-cell (corr2d, corr3d) heat map and
was unreadable for exactly that reason: 18 of 21 cells tied, because they were the
same r. Collapsing onto r turns a flat grid into a curve with a clear knee.

TWO AXES BECAUSE THE TWO METRICS SATURATE AT DIFFERENT POINTS, and that is the
finding: cross-view IDF1 is flat from r = 1, but the switch rate keeps falling well
past that -- 569 per 100,000 camera-frames with no 3D term at all, 9.66 at r = 1,
0.0466 at r = 4, and a floor of 0.0378 from r = 12. IDF1 alone would say "anything
>= 1 is fine"; the switch rate says where it actually stops improving. The shipped
r = 6 (0.0450) sits comfortably past both knees. (Both statements are 8-session,
shipped-anchor statements; the 50-session two-arm default is now the measurement.)

r IS ON A REAL LOG AXIS, NOT A CATEGORY INDEX. It used to be plotted at
`np.arange(len(df))` -- the 12 sampled ratios 0, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12,
16, 24 at EQUAL spacing -- and that made both of the claims above partly artefacts
of the sampling: on an index, the distance from r = 1 to r = 2 is the same as from
r = 16 to r = 24, so "the knee is at 2" and "the shipped 6 sits past both knees"
were being read off a geometry that has nothing to do with r. Worse, 12 ticks over
~30 mm of plot is 2.5 mm of pitch, so 7 of the 12 tick labels had to be suppressed
to stop them colliding and the reader could not place a knee at all.

Of the three fixes available, a genuine log axis is the only one that fixes the
GEOMETRY: rotating all 12 labels to 90 deg would make them legible but leaves the
spacing false, and printing "x is an index, spacing is not proportional" is honest
but still unreadable. The cost of the log axis is that a subset of ticks is still
labelled -- 0, 1, 2, 6, 24, which is what fits at 8 pt in 30 mm -- but that is
now harmless, because positions are proportional and interpolating between labelled
decades is exactly what a log axis is for. Every sampled r is still visible: each is
drawn with its own marker.

r = 0 IS OFF A LOG AXIS, SO IT GETS A BREAK. r = 0 is the "no 3D term at all"
control the handoff asked for and the point of the panel (569 switches per 100,000
camera-frames without it, 151x the shipped ratio's rate), so it cannot be dropped
just because log(0) is undefined. It is drawn in a
slot to the left of the log region, its tick labelled `0`, with an explicit break
mark on the x spine and a DOTTED connector across the break -- so the one position
on the axis that is not to scale announces itself, and the other eleven are.
`BREAK_DEC` is the size of that slot in decades; nothing else on the panel depends
on it.
"""
import glob
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.ticker import FixedFormatter, FixedLocator, NullLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (INK, MUTED, GREY, SALMON, TEAL, deposit, footnote, panel,  # noqa: E402
                       save, text_legend, use)

METRIC = "idf1_cross"

#: Rate basis for ID switches. See the docstring for why not percent.
PER = 100_000

#: The app's shipped ratio (corr2d 1.0, corr3d 6.0 -> r = 6).
SHIPPED_R = 6.0

#: Width of the r = 0 slot, in DECADES to the left of the smallest positive r. Wide
#: enough that its `0` tick label clears the next labelled tick, narrow enough that
#: the break reads as a break rather than as a second panel.
BREAK_DEC = 0.20

#: Which r values get a tick LABEL. Every r is drawn (each has a marker); these are
#: the ones whose labels fit at 8 pt in a ~30 mm plot without colliding, and they are
#: exactly the set the panel's argument is made from: 0 the control, 1 and 2 the two
#: knees, 6 the shipped ratio, 24 the end of the sweep. MEASURED, not guessed -- an
#: earlier version also labelled 0.5, whose glyphs ended 0.80 mm (2.3 pt) from the
#: "1" beside it, i.e. one space width: PyMuPDF read the two as a single "0.5 1" span
#: and so would a reader. The remaining gaps are 3.2 / 2.0 / 4.1 / 4.7 mm.
LABELLED_R = (0.0, 1.0, 2.0, 6.0, 24.0)

#: The fresh-anchor sweep deposit (fig3_sweep50.py's digest-tagged filename). Globbed
#: so the digest is not duplicated here; smoke-test tags (`__f<cap>__s<n>`) excluded.
FRESH_GLOB = "fig3_sweep50__distanceThreshold25-stale20-sync_*.json"

#: Arm names as they appear in the key and the deposited CSV.
#: RENAMED 2026-08-17 (Eric's decision): the fresh-anchor operating point (sync
#: association, stale 20, distanceThreshold 25, corr3dWeight 6) is now the
#: SHIPPED configuration, and the arm that shipped before it is the previous
#: default. The mechanism words stay; only the status tag moved.
SHIPPED_NAME = "previous default"
FRESH_NAME = "greedy (LUC3D)"


def _rows(dep, arm):
    """One arm's cells -> tidy rows, with the collapse-onto-r check."""
    cells = [c for c in dep["cells"] if c.get(METRIC) is not None]
    df = pd.DataFrame(cells)
    df["r"] = df.corr3d / df.corr2d
    for r, g in df.groupby("r"):
        if g[METRIC].nunique() > 1 or g["switches"].nunique() > 1:
            sys.exit(
                f"fig3e [{arm}]: cells with r={r:g} disagree "
                f"({sorted(g[METRIC].unique())}, switches {sorted(g.switches.unique())})"
                " — the sweep is no longer one-dimensional in corr3d/corr2d, so this "
                "panel's collapse is invalid. Plot the full grid instead.")
    out = (df.groupby("r")
             .agg(idf1=(METRIC, "first"), switches=("switches", "first"),
                  n_cells=("switches", "size"), n_sessions=("n_sessions", "first"))
             .reset_index().sort_values("r"))
    out["arm"] = arm
    return out


def build():
    """Both 50-session arms, denominator-checked against each other."""
    shipped = load("fig3_sweep50.json")
    hits = sorted(p.name for p in
                  (Path(__file__).resolve().parent.parent / "out").glob(FRESH_GLOB)
                  if "__f" not in p.name)
    if not hits:
        sys.exit("fig3e: no fresh-anchor 50-session sweep deposit. Run:\n"
                 "  $PY figs/fig3_sweep50.py --grid-corr3d "
                 "0,0.25,0.5,1,2,3,4,6,8,12,16,24 --grid-corr2d 1 "
                 "--method '{\"sync\":true,\"stale\":20}' "
                 "--thresholds '{\"distanceThreshold\":25}'")
    fresh = load(hits[-1])

    # THE DENOMINATOR GATE. A rate axis shared by two arms is a lie unless both
    # accumulated over the same exposure; see the docstring.
    tcf_s, tcf_f = shipped.get("total_camera_frames"), fresh.get("total_camera_frames")
    if not tcf_s or not tcf_f:
        sys.exit("fig3e: a 50-session sweep deposit has no total_camera_frames")
    if tcf_s != tcf_f:
        sys.exit(f"fig3e: the two arms' denominators differ ({tcf_s:,} vs {tcf_f:,}) "
                 "— not the same corpus; refusing to put them on one rate axis.")

    df = pd.concat([_rows(shipped, SHIPPED_NAME), _rows(fresh, FRESH_NAME)],
                   ignore_index=True)
    bad_n = df[df.n_sessions != 50]
    if len(bad_n):
        sys.exit(f"fig3e: cells scored on != 50 sessions:\n{bad_n}")
    rs, rf = (set(df[df.arm == a].r) for a in (SHIPPED_NAME, FRESH_NAME))
    if rs != rf:
        sys.exit(f"fig3e: the two arms sample different r values: "
                 f"{sorted(rs)} vs {sorted(rf)}")
    df["camera_frames"] = tcf_s
    df["switches_per_100k_camera_frames"] = df.switches / tcf_s * PER
    return df, tcf_s


def _axes_setup(ax, rate_min, rate_max, zero_x, first, has_zero):
    """The shared r-axis machinery: log x with the r = 0 break, log rate y."""
    ax.set_yscale("log")

    # PLAIN NUMBERS ON EVERY DECADE THE DATA TOUCHES, not matplotlib's default
    # powers of ten (see the legacy section's reasoning). The candidate ladder is
    # filtered to the measured range so the two-arm panel (0.8 .. ~630 per 100k)
    # and the legacy panel (3.8 .. 569) both get full coverage.
    decades = [v for v in (0.3, 1, 3, 10, 30, 100, 300, 1000)
               if rate_min * 0.9 <= v <= rate_max * 1.3]
    ax.yaxis.set_major_locator(FixedLocator(decades))
    ax.yaxis.set_major_formatter(FixedFormatter([f"{v:g}" for v in decades]))
    ax.yaxis.set_minor_locator(FixedLocator([]))
    ax.set_ylim(rate_min * 10 ** -0.12, rate_max * 10 ** 0.12)

    ax.set_xscale("log")
    ax.set_xlim((zero_x if has_zero else first) * 10 ** -0.22, 24 * 10 ** 0.11)
    ticks = [v for v in LABELLED_R if v > 0 or has_zero]
    ax.set_xticks([zero_x if v == 0 else v for v in ticks])
    ax.set_xticklabels([f"{v:g}" for v in ticks])
    ax.xaxis.set_minor_locator(NullLocator())
    ax.set_xlabel("r = corr3d / corr2d (log)")
    # THE BREAK, ON THE SPINE (see the legacy section).
    if has_zero:
        tr = ax.get_xaxis_transform()
        mid = (zero_x * first) ** 0.5
        ax.plot([mid * 10 ** -0.055, mid * 10 ** 0.055], [0, 0], color="white",
                lw=1.6, transform=tr, clip_on=False, zorder=5,
                solid_capstyle="butt")
        for off in (-0.030, 0.030):
            ax.plot([mid * 10 ** (off - 0.022), mid * 10 ** (off + 0.022)],
                    [-0.030, 0.030], color=MUTED, lw=0.8, transform=tr,
                    clip_on=False, zorder=6)


def main(with_shipped=False):
    use()
    df, tcf = build()
    deposit(df, 3, "fig3d_sweep.csv")

    # A THIRD: this panel shares its row with d and f (see the legacy section's
    # note on why the grid only closes at 180 mm if all three are "third").
    # TWO STACKED AXES (Eric, 2026-08-15): grid() at panel width, ~34 mm per plot.
    from src.style import grid as _grid
    fig, (ax_top, ax_bot) = _grid(2, 1, span="third", row="std")
    # A KEY BAND ABOVE BOTH PLOTS, reserved the way `panel(key=...)` reserves one --
    # `grid()` has none of its own. Two series names and the app-default note share it,
    # so nothing that identifies a line sits inside the data any more (Eric, 2026-08-18:
    # "just say exhaustive and greedy in green and blue at the top, bring app default
    # up"). 0.105 of the panel height carries two 7 pt rows; the axes give that up once,
    # not once each, because the band is above the whole grid.
    #
    # 0.075, NOT 0.105, AND THAT IS SET BY THE Y LABELS. Both are rotated and set along
    # their own ~17 mm axis with millimetres to spare ("ID switches /100k" measured
    # ~16.5 mm at 7 pt); take 0.105 of the panel and each axis drops to ~15 mm, the
    # labels overrun their own axes, and the two of them print through each other in the
    # middle of the panel -- which `lint_text.py` does NOT catch, because two thin
    # rotated boxes crossing overlap less than its 18% floor. The band is one row, the
    # labels come down to 6.5 pt, and the top one loses its "ID" (the panel measures no
    # other kind of switch).
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - 0.075))
    ax = ax_top

    r = np.sort(df.r.unique()).astype(float)
    first = float(r[r > 0].min())
    zero_x = first * 10 ** -BREAK_DEC
    has_zero = bool(r[0] == 0.0) and bool((r[1:] > 0).all())

    def series(axis, arm_df, col, color, fresh_arm):
        """One arm of one metric.

HOLLOW + DASHED = FRESH ANCHOR, FILLED + SOLID = SHIPPED. Briefly changed to
        thin-dotted vs bold-solid on 2026-08-14 and changed straight back on review:
        the weight-only encoding made the shipped arm look like a de-emphasised
        annotation rather than the control it is, and the marker fill is what actually
        separates the four series where the two curves cross.
        """
        g = arm_df.sort_values("r")
        rr = g.r.to_numpy(dtype=float)
        x = np.where(rr > 0, rr, zero_x)
        pos = rr > 0
        y = g[col].to_numpy(dtype=float)
        ls = (0, (2.6, 1.6)) if fresh_arm else "-"
        lw = 1.5 if fresh_arm else 2.0
        axis.plot(x[pos], y[pos], color=color, lw=lw, ls=ls, zorder=3)
        if has_zero:
            axis.plot(x[:2], y[:2], color=color, lw=1.2, ls=(0, (1.4, 1.2)),
                      zorder=3)
        if fresh_arm:
            axis.plot(x, y, "o", mfc="white", mec=color, mew=1.2, ms=4, zorder=4)
        else:
            axis.plot(x, y, "o", color=color, ms=4, mec="white", mew=0.8, zorder=4)

    # TWO STACKED PLOTS, ONE METRIC EACH (Eric, 2026-08-15: "I hate that there are
    # two axes and two colour schemes and hollow and solid and dashed and solid --
    # make two different graphs, one for switches and one for IDF1, stack them
    # vertically"). One encoding everywhere: teal = LUC3D fresh anchor, salmon =
    # exhaustive, solid lines, filled markers; the metric is the SUBPLOT. Exhaustive
    # is flat because it has no cost-weight ratio to sweep, and its label is the bare
    # word -- "(no r)" went, per the same message.
    exh = load("fig3_exhaustive_bmimica.json")
    df["rate"] = df.switches.clip(lower=1) / tcf * PER
    exh_rate = exh["switches_per_100k_camera_frames"]
    # THE FAIR BASIS (2026-08-18): both rules over the frames exhaustive computed.
    fm = load("fig3_frame_matched_bmimica.json")
    fm_e, fm_g = fm["arms"]["exhaustive"], fm["arms"]["greedy"]
    # The switch rate is the invariant across the two scorings -- exhaustive's
    # switches were always counted on its own computed frames -- so an inequality
    # here means the frame-matched rescore is NOT the same measurement as the
    # published deposit and neither number may be drawn beside the other.
    if abs(fm_e["switches_per_100k_camera_frames"] - exh_rate) > 1e-4:
        sys.exit(f"fig3d: frame-matched exhaustive switch rate "
                 f"{fm_e['switches_per_100k_camera_frames']:.5f} != the published "
                 f"deposit's {exh_rate:.5f} -- the two rescores disagree on the arm "
                 f"they share; reconcile before drawing")
    if fm_e["camera_frames_scored"] != fm_g["camera_frames_scored"]:
        sys.exit("fig3d: the two frame-matched arms were scored over different "
                 "camera-frame counts -- the rules would not be comparable")
    # The footnote states the matched frames as a SHARE of this panel's own exposure,
    # so the two denominators must be the same population: 50 sessions x 5 cameras,
    # 45,021,960 camera-frames in the sweep deposit and 9,004,392 x 5 in the
    # head-to-head's `framesConsidered`. Equal, and asserted because a mismatch would
    # turn the share into a ratio of two different corpora.
    if fm_e["camera_frames_scored"] > tcf:
        sys.exit(f"fig3d: the frame-matched arms cover "
                 f"{fm_e['camera_frames_scored']:,} camera-frames, more than this "
                 f"panel's own {tcf:,} -- the two deposits are not the same corpus")

    def sweep_line(axis, ycol):
        g = df[df.arm == FRESH_NAME].sort_values("r")
        rr = g.r.to_numpy(dtype=float)
        x = np.where(rr > 0, rr, zero_x)
        pos = rr > 0
        y = g[ycol].to_numpy(dtype=float)
        axis.plot(x[pos], y[pos], color=TEAL, lw=1.8, zorder=3)
        if has_zero:
            axis.plot(x[:2], y[:2], color=TEAL, lw=1.2, ls=(0, (1.4, 1.2)), zorder=3)
        axis.plot(x, y, "o", color=TEAL, ms=4, mec="white", mew=0.8, zorder=4)

    # No in-plot "exhaustive" labels (Eric, 2026-08-15): the key above names it
    # once, and in the top plot the label collided with the descending curve.
    def exh_line(axis, yval, off):
        axis.axhline(yval, color=SALMON, lw=1.8, zorder=2)
        axis.plot([zero_x, r[-1]], [yval] * 2, "s", color=SALMON, ms=3.4,
                  mec="white", mew=0.7, zorder=3, clip_on=False)

    # THE SAME-FRAMES GREEDY RULE IS NOT DRAWN (Eric, 2026-08-18: "we dont need ...
    # LUC3D greedy 0.79 and 8.0/100k ... written there"). It was a grey dashed rule at
    # the greedy arm's own frame-matched values, added the same day as the frame-matched
    # exhaustive rule so the pair could be read like for like. Its numbers are NOT lost:
    # both arms are deposited in `data/fig3/fig3d_frame_matched_rules.csv` and quoted in
    # the caption (greedy 0.791 IDF1, 8.0 switches per 100k on exactly the frames
    # exhaustive can enter, against exhaustive's 0.628 and 81.0). Dropping it also
    # removes an unnamed line style from the artwork, which is the defect this panel's
    # neighbour 2b was just fixed for.

    _axes_setup(ax_top, min(float(df.rate.min()), exh_rate),
                max(float(df.rate.max()), exh_rate), zero_x, first, has_zero)
    # Compact axis: full decades only. The 0.3/3/30/300 half-steps collided at
    # ~17 mm of axis height (lint: adjacent labels 19% overlapped).
    ax_top.yaxis.set_major_locator(FixedLocator([1, 10, 100]))
    ax_top.yaxis.set_major_formatter(FixedFormatter(["1", "10", "100"]))
    sweep_line(ax_top, "rate")
    exh_line(ax_top, exh_rate, -7)
    # ROTATED Y LABELS, SIZED TO FIT (Eric, 2026-08-15: "you should label the y
    # axis but just make the text fit" -- the horizontal-caption attempt is out).
    # The constraint is real: a label may not overrun its own ~17 mm axis. At 7 pt,
    # "ID switches /100k" is ~16.5 mm and "cross-view IDF1" ~15 mm set along the
    # rule, so both fit INSIDE their own axis with a hair to spare; the full
    # denominator ("per 100,000 camera-frames") stays in the footnote, where the
    # rate basis is stated exactly.
    ax_top.set_ylabel("switches /100k", fontsize=6.5)
    ax_top.tick_params(labelbottom=False)
    ax_top.set_xlabel("")

    _axes_setup(ax_bot, 1.0, 10.0, zero_x, first, has_zero)  # x machinery
    ax_bot.set_yscale("linear")                              # ...linear y for IDF1
    ax_bot.yaxis.set_major_locator(FixedLocator([0.4, 0.6, 0.8]))
    ax_bot.yaxis.set_major_formatter(FixedFormatter(["0.4", "0.6", "0.8"]))
    ax_bot.yaxis.set_minor_locator(NullLocator())
    ax_bot.set_ylim(0.35, 0.92)
    sweep_line(ax_bot, "idf1")
    exh_line(ax_bot, fm_e["idf1_cross_mean"], 5)
    # THE RULES ARE DRAWN, SO THE RULES ARE DEPOSITED. Their values live in
    # out/fig3_frame_matched_bmimica.json, which is not a tracked artefact; the four
    # numbers on the artwork belong in data/ beside the curve they are compared with.
    deposit(pd.DataFrame([
        {"arm": arm, "basis": "frames exhaustive computed (both arms)",
         "idf1_cross_mean": a["idf1_cross_mean"],
         "idf1_cross_median": a["idf1_cross_median"],
         "switches": a["switches_total"],
         "switches_per_100k_camera_frames": a["switches_per_100k_camera_frames"],
         "camera_frames_scored": a["camera_frames_scored"],
         "n_sessions": fm["n_sessions"]}
        for arm, a in (("exhaustive", fm_e), ("greedy (head-to-head, default)", fm_g))
    ]), 3, "fig3d_frame_matched_rules.csv")
    ax_bot.set_ylabel("cross-view IDF1", fontsize=6.5)

    footnote(ax_bot, "r = 0: no 3D term, left of the break\n"
             f"rate basis: {tcf:,} camera-frames (50 sessions x 5 cameras, "
             f"full length), corr2d = 1 row\n"
             f"the two flat rules are FRAME-MATCHED: exhaustive and the head-to-head "
             f"greedy arm (fig3_bench.mjs at default thresholds), both scored over "
             f"the same {fm_e['camera_frames_scored']:,} camera-frames -- the "
             f"{fm_e['camera_frames_scored'] / tcf:.0%} of frames where "
             f"every camera holds exactly 2 clean detections, which is the only set "
             f"exhaustive can enter. Scoring exhaustive over the whole session, as "
             f"this panel did until 2026-08-18, charged it an identity miss for every "
             f"frame it cannot enter and put the rule at 0.400 instead of "
             f"{fm_e['idf1_cross_mean']:.3f}. Its identities still come from our "
             f"nearest-centroid threading, not the published method; the two choose "
             f"the same partition on 99.996% of these frames")

    for axis in (ax_top, ax_bot):
        axis.axvline(SHIPPED_R, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    # UP INTO THE BAND ("bring app default up"), on the key's own row rather than 2 pt
    # off the top spine. Still anchored to r = 6 in DATA x, so it stays over the rule it
    # names whatever the axis does; only its vertical offset changed, from +2 pt to the
    # band's own line.
    ax_top.annotate(f"app default r = {SHIPPED_R:g}", (SHIPPED_R, 1.0),
                    xycoords=("data", "axes fraction"), xytext=(0, 9),
                    textcoords="offset points", color=MUTED, fontsize=6.5,
                    ha="center", va="bottom")

    # The key rides INSIDE the top plot's clear upper-right corner: grid() has no
    # reserved key band, and drawn "above" it landed on the axes (lint: on the 300
    # tick and the data). At r >= 1 the switch-rate curve is at the bottom decade,
    # so the corner is empty.
    # TWO LINES, still right-anchored: "(shipped)" joined the name 2026-08-17
    # (the fresh anchor is the app's shipped configuration now) and on one line
    # the label would reach x ~ 0.13, into the descending switch-rate curve's
    # top-left region; stacked, it keeps the one-line footprint.
    # AT 0.60, BELOW the exhaustive rule: at the old 0.93 anchor the second line
    # printed straight through the salmon rule -- which sits at 0.675 of the
    # axes height (79.4/100k on this log axis), MEASURED via lint's on-data
    # check after a first cut at 0.68 landed the top line exactly on it. The
    # band between the rule and the teal tail (~0.04) is empty at r >= 2.
    # TWO WORDS IN THE BAND, ONE PER SERIES, and nothing else on the artwork identifies
    # a line (Eric, 2026-08-18: "just say exhaustive and greedy"). The long name this
    # replaces -- "LUC3D, fresh anchor (shipped)" -- was inside the top plot and had
    # already been moved twice to dodge the data; WHICH configuration is swept is a
    # caption fact, not a thing the curve needs to carry, and the caption states it
    # ("for the fresh-anchor configuration of c").
    # SALMON AND TEAL, not the blue/green the instruction named: salmon IS "exhaustive"
    # in this figure's a, c and e, and teal is LUC3D set-wide, so recolouring d alone
    # would leave the figure disagreeing with itself about what a hue means. Confirmed
    # with Eric before drawing.
    fig.text(0.16, 0.985, "exhaustive", ha="left", va="top", color=SALMON,
             fontsize=7, fontweight="bold")
    fig.text(0.52, 0.985, "greedy", ha="left", va="top", color=TEAL,
             fontsize=7, fontweight="bold")
    # ONE NAME PER SUBPLOT: two 7 pt lines need ~0.30 of a 17 mm axis and the top
    # corner has ~0.20 above the exhaustive rule -- they collided with each other or
    # with the rule at every spacing tried. The teal name stays here; the salmon name
    # labels the BOTTOM plot, whose region below the flat 0.40 rule is empty, and the
    # colours bind the pairs across the two plots.
    # x = 0.60: at 0.97 the label crossed the app-default r = 6 rule (10% inked);
    # between r = 2 and r = 6 nothing is drawn below the exhaustive rule.
    # THE 0.400 RULE IS A COARSE ESTIMATE AND THE ARTWORK SAYS SO (adversarial
    # review 2026-08-17): the exhaustive deposit's own caveat marks its IDF1 as
    # not-citable -- the identity threading that makes IDF1 computable for a
    # pure per-frame method is our scaffolding, not Maree et al.'s (see 3e's
    # docstring). The rule stays as the reference it is; the gloss rides as the
    # label's second line. BOTH ABOVE the rule: the rule sits at ~0.09 of the
    # axes height, so anything hung under it prints through it (the first cut
    # of this fix did exactly that); between the rule and the teal curve's
    # ~0.44 floor there is room for two lines.
    save(fig, 3, "e", "sweep" if not with_shipped else "sweep_with_shipped")


# --------------------------------------------------------------------------------
# The retired 8-session shipped-only panel, verbatim. Renders pixel-identical to
# the committed artwork under the `sweep_legacy8` slug.
# --------------------------------------------------------------------------------

def build_legacy8() -> pd.DataFrame:
    sweep = load("fig3_sweep.json")
    # THE DENOMINATOR IS READ, NOT ASSUMED. Without it the panel refuses to draw
    # rather than fall back to a plausible camera-frame count: a rate against a
    # guessed exposure is worse than the raw sum it replaced.
    tcf = sweep.get("total_camera_frames")
    if not tcf:
        sys.exit("fig3e: fig3_sweep.json has no total_camera_frames -- run "
                 "`python3 figs/fig3_sweep.py --denominators` to measure it (seconds; "
                 "it re-reads only the HDF5 shapes, not the tracker runs or scoring).")
    cells = [c for c in sweep["cells"] if c.get(METRIC) is not None]
    df = pd.DataFrame(cells)
    df["r"] = df.corr3d / df.corr2d

    # VERIFY the collapse rather than asserting it. If a future sweep breaks the
    # ratio-only property this panel would silently average two different regimes.
    for r, g in df.groupby("r"):
        if g[METRIC].nunique() > 1 or g["switches"].nunique() > 1:
            sys.exit(
                f"fig3e: cells with r={r:g} disagree "
                f"({sorted(g[METRIC].unique())}, switches {sorted(g.switches.unique())})"
                " — the sweep is no longer one-dimensional in corr3d/corr2d, so this "
                "panel's collapse is invalid. Plot the full grid instead.")

    out = (df.groupby("r")
             .agg(idf1=(METRIC, "first"), switches=("switches", "first"),
                  n_cells=("switches", "size"), n_sessions=("n_sessions", "first"))
             .reset_index().sort_values("r"))
    # Raw sum AND rate in the deposit, with the denominator alongside, so the CSV
    # is checkable by division.
    out["camera_frames"] = tcf
    out["switches_per_100k_camera_frames"] = out.switches / tcf * PER
    return out


def main_legacy8():
    use()
    df = build_legacy8()
    deposit(df, 3, "fig3d_sweep_legacy8.csv")

    # A THIRD, NOT A HALF. This panel shares its row with d and f, and the grid only
    # closes at 180 mm if all three are "third": at "half" that row summed to 210.6 mm
    # and `assemble.py` used to CENTRE an over-wide row, so its first panel was placed
    # at x = -15.3 mm and had its y axis cut off the page. Nothing in a per-panel
    # render shows that; `assemble.py` now refuses the row instead.
    fig, ax = panel("third", "std", key=2)

    # r ON A LOG AXIS, with the r = 0 control in a broken-off slot to its left. See
    # the docstring: at even spacing this axis made "the knee is at r = 2" a
    # statement about the sampling grid rather than about r.
    r = df.r.to_numpy(dtype=float)
    first = float(r[r > 0].min())                 # 0.25, the smallest sampled ratio
    zero_x = first * 10 ** -BREAK_DEC             # where the r = 0 datum is drawn
    x = np.where(r > 0, r, zero_x)
    pos = r > 0
    # Row 0 is r = 0 only because build() sorts ascending and the control is in the
    # sweep. Checked rather than assumed: if the control ever drops out of the JSON,
    # `x[:2]` would silently draw a "break" connector between two real ratios.
    has_zero = bool(r[0] == 0.0) and bool(pos[1:].all())

    def series(axis, y, color, ms):
        """One series: solid over the log region, DOTTED across the break."""
        axis.plot(x[pos], y[pos], color=color, lw=2.0, zorder=3)
        if has_zero:
            axis.plot(x[:2], y[:2], color=color, lw=1.2, ls=(0, (1.4, 1.2)),
                      zorder=3)
        axis.plot(x, y, "o", color=color, ms=ms, mec="white", mew=0.8, zorder=4)

    # ID-switch RATE, log, on the left. The floor is the rate ONE switch would
    # give, which is what `.clip(lower=1)` meant on the count axis: a cell with no
    # switches at all cannot be placed on a log axis, and pinning it at the
    # smallest event the measurement can resolve is the honest placement.
    rate = df.switches.clip(lower=1).to_numpy(dtype=float) / df.camera_frames.iloc[0] * PER
    series(ax, rate, SALMON, 4)
    ax.set_yscale("log")
    # The denominator is IN the axis label -- the footnote is no longer drawn
    # (src.style.footnote reports to the build log), so a unit that lives only
    # there would not reach the reader.

    # PLAIN NUMBERS ON EVERY DECADE THE DATA TOUCHES, not matplotlib's default
    # powers of ten. The series runs 3.8 to 569, so the default labelled only 10^1
    # and 10^2 and the four lowest points sat BELOW the lowest label with nothing to
    # place them against: read quickly, 3.8 looks like it could be 0.38. Ticks at 3,
    # 10, 30, 100 and 300 in plain digits make the bottom of the range readable,
    # which is where the panel's own claim lives -- the 3D term takes the rate from
    # 569 to under 4.
    decades = [3, 10, 30, 100, 300]
    ax.yaxis.set_major_locator(FixedLocator(decades))
    ax.yaxis.set_major_formatter(FixedFormatter([str(v) for v in decades]))
    ax.yaxis.set_minor_locator(FixedLocator([]))
    ax.set_ylim(rate.min() * 10 ** -0.12, rate.max() * 10 ** 0.12)

    ax.set_xscale("log")
    # Limits in decades either side, so the r = 0 slot and the 24 label both clear
    # the spines. Minor ticks off: on a log axis they are a grey haze at this size,
    # and every sampled r already carries a marker.
    ax.set_xlim((zero_x if has_zero else first) * 10 ** -0.22, 24 * 10 ** 0.11)
    ticks = [v for v in LABELLED_R if v > 0 or has_zero]
    ax.set_xticks([zero_x if v == 0 else v for v in ticks])
    ax.set_xticklabels([f"{v:g}" for v in ticks])
    ax.xaxis.set_minor_locator(NullLocator())
    ax.set_xlabel("r = corr3d / corr2d (log)")
    # THE BREAK, ON THE SPINE. Two slashes with the spine whited out between them, so
    # the one position on this axis that is not to scale says so. Drawn in the x-axis
    # transform (x in data, y in axes fractions) and unclipped, so it sits ON the
    # spine rather than inside the data area.
    if has_zero:
        tr = ax.get_xaxis_transform()
        mid = (zero_x * first) ** 0.5
        ax.plot([mid * 10 ** -0.055, mid * 10 ** 0.055], [0, 0], color="white",
                lw=1.6, transform=tr, clip_on=False, zorder=5,
                solid_capstyle="butt")
        for off in (-0.030, 0.030):
            ax.plot([mid * 10 ** (off - 0.022), mid * 10 ** (off + 0.022)],
                    [-0.030, 0.030], color=MUTED, lw=0.8, transform=tr,
                    clip_on=False, zorder=6)
    # "(no 3D term)" used to be the second line of the r = 0 tick label. Centred on
    # the leftmost tick it is ~50 pt wide and ran off the left edge of the narrower
    # panel, so the gloss moves under the axis where its width is the panel's.
    # Legacy printed "LUC3D only · both series are this tracker" on this panel and
    # the restyle dropped it. In a figure whose panel f runs LUC3D against an
    # exhaustive baseline, an unlabelled two-series ablation reads as a
    # between-method comparison, which this one is not.
    footnote(ax, "r = 0: no 3D term, left of the break\n"
                 "both series are LUC3D against itself\n"
                 f"rate basis: {int(df.camera_frames.iloc[0]):,} camera-frames "
                 f"(8 sessions x 5 cameras, full length)")

    # Cross-view IDF1 on the right.
    ax2 = ax.twinx()
    ax2.spines["top"].set_visible(False)
    series(ax2, df.idf1.to_numpy(dtype=float), TEAL, 4)
    ax2.set_ylabel("cross-view IDF1", color=TEAL)
    ax2.tick_params(axis="y", colors=TEAL)
    ax2.spines["right"].set_color(TEAL)

    # The shipped ratio, at its own place on the r axis now that the axis has one.
    xr = SHIPPED_R
    ax.axvline(xr, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    ax.annotate(f"shipped r = {SHIPPED_R:g}", (xr, 1.0),
                xycoords=("data", "axes fraction"), xytext=(0, 2),
                textcoords="offset points", color=MUTED, fontsize=6.5,
                ha="center", va="bottom")

    text_legend(ax, [("ID-switch rate", SALMON), ("cross-view IDF1", TEAL)], "above")
    save(fig, 3, "e", "sweep_legacy8")


if __name__ == "__main__":
    main_legacy8() if "--legacy8" in sys.argv else main(with_shipped='--with-shipped' in sys.argv)
