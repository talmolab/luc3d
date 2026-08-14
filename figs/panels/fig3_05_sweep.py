#!/usr/bin/env python3
"""
Fig 3d -- 3D-term ablation: ID-switch RATE and cross-view IDF1 against r = corr3d/corr2d,
now over ALL 50 proofread BMimica sessions and BOTH tracker states.

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
from src.style import (MUTED, GREY, SALMON, TEAL, deposit, footnote, panel,  # noqa: E402
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
SHIPPED_NAME = "shipped tracker"
FRESH_NAME = "fresh anchor"


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
    ax.set_ylabel("ID switches per\n100,000 camera-frames", color=SALMON)
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
    ax.tick_params(axis="y", colors=SALMON)
    ax.spines["left"].set_color(SALMON)

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
    fig, ax = panel("third", "std", key=4)

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

    # ID-switch RATE, log, on the left. `.clip(lower=1)` pins a zero-switch cell at
    # the smallest event the measurement can resolve (see the legacy section).
    # EXHAUSTIVE vs THE FRESH ANCHOR (review 2026-08-14: "3e should be exhaustive vs
    # fresh anchor, not greedy shipped"). The shipped arm is out of the default render
    # -- still swept, still deposited, back with --with-shipped -- and the reference
    # level is exhaustive enumeration, which has no r (it does not use the cost
    # weights), so it is a horizontal rule on each axis in its own colours.
    # Its numbers come from figs/out/fig3_exhaustive_bmimica.json, the 50-session
    # aggregation of the head-to-head harness's own per-session scores. Its switch
    # RATE uses ITS OWN denominator (clean camera-frames -- exhaustive only runs where
    # every camera holds exactly 2 detections); the deposit states both.
    exh = load("fig3_exhaustive_bmimica.json")
    arms_drawn = ([(SHIPPED_NAME, False)] if with_shipped else []) + \
        [(FRESH_NAME, True)]
    df["rate"] = df.switches.clip(lower=1) / tcf * PER
    exh_rate = exh["switches_per_100k_camera_frames"]
    _axes_setup(ax, min(float(df.rate.min()), exh_rate),
                max(float(df.rate.max()), exh_rate),
                zero_x, first, has_zero)
    for arm, is_fresh in arms_drawn:
        series(ax, df[df.arm == arm], "rate", SALMON, is_fresh)
    # EXHAUSTIVE AS A SERIES, NOT FURNITURE (Eric, 2026-08-15: "why only lines?").
    # It cannot curve -- r is LUC3D's cost-weight ratio and exhaustive never uses the
    # weights, so its value is identical at every r; flat is its true shape. But a
    # thin axhline read as a gridline, so it is now drawn at series weight, with
    # endpoint markers and its name ON the line in its own colour.
    ax.axhline(exh_rate, color=SALMON, lw=1.6, ls=(0, (4.0, 2.0)), zorder=2)
    ax.plot([zero_x, r[-1]], [exh_rate] * 2, "s", color=SALMON, ms=3.4,
            mec="white", mew=0.7, zorder=3, clip_on=False)
    # BELOW the line, not above: above it the label sat on the fresh-anchor curve
    # descending through the same band (lint: 7% inked).
    ax.annotate("exhaustive (no r)", (zero_x, exh_rate),
                textcoords="offset points", xytext=(2, -7), ha="left", va="top",
                color=SALMON, fontsize=6.5, fontweight="bold")

    footnote(ax, "r = 0: no 3D term, left of the break\n"
                 f"rate basis: {tcf:,} camera-frames (50 sessions x 5 cameras, "
                 f"full length), corr2d = 1 row; exhaustive's rate is over its own "
                 f"{exh['camera_frames_computed']:,} clean camera-frames")

    # Cross-view IDF1 on the right.
    ax2 = ax.twinx()
    ax2.spines["top"].set_visible(False)
    for arm, is_fresh in arms_drawn:
        series(ax2, df[df.arm == arm], "idf1", TEAL, is_fresh)
    ax2.axhline(exh["idf1_cross_mean"], color=TEAL, lw=1.6, ls=(0, (4.0, 2.0)),
                zorder=2)
    ax2.plot([zero_x, r[-1]], [exh["idf1_cross_mean"]] * 2, "s", color=TEAL,
             ms=3.4, mec="white", mew=0.7, zorder=3, clip_on=False)
    ax2.annotate("exhaustive", (r[-1], exh["idf1_cross_mean"]),
                 textcoords="offset points", xytext=(-2, 5), ha="right",
                 color=TEAL, fontsize=6.5, fontweight="bold")
    ax2.set_ylabel("cross-view IDF1", color=TEAL)
    ax2.tick_params(axis="y", colors=TEAL)
    ax2.spines["right"].set_color(TEAL)

    # The shipped ratio, at its own place on the r axis.
    ax.axvline(SHIPPED_R, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    # "app default", not "shipped": on the default render the curve at this rule is
    # the FRESH ANCHOR, and calling the marker "shipped" attached that word to a
    # curve that is not the shipped tracker (review 2026-08-14, finding 5).
    ax.annotate(f"app default r = {SHIPPED_R:g}", (SHIPPED_R, 1.0),
                xycoords=("data", "axes fraction"), xytext=(0, 2),
                textcoords="offset points", color=MUTED, fontsize=6.5,
                ha="center", va="bottom")

    # "hollow: fresh anchor" answered a question the default render no longer asks
    # (hollow as opposed to WHAT? -- the filled shipped arm only exists under
    # --with-shipped). The series is named plainly; the exhaustive rules keep their
    # dash description plus their denominator caveat, which is the one fact a reader
    # needs to not compare the two rates as equals (review 2026-08-14, finding 2).
    key = [("ID-switch rate", SALMON), ("cross-view IDF1", TEAL),
           ("squares: exhaustive (clean frames)", MUTED),
           ("curves: fresh anchor", MUTED)]
    if with_shipped:
        key = [("ID-switch rate", SALMON), ("cross-view IDF1", TEAL),
               ("squares: exhaustive (clean frames)", MUTED),
               ("filled: shipped tracker", MUTED),
               ("hollow: fresh anchor", MUTED)]
    text_legend(ax, key, "above")
    save(fig, 3, "d", "sweep" if not with_shipped else "sweep_with_shipped")


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
    ax.set_ylabel("ID switches per\n100,000 camera-frames", color=SALMON)
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
    ax.tick_params(axis="y", colors=SALMON)
    ax.spines["left"].set_color(SALMON)

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
    save(fig, 3, "d", "sweep_legacy8")


if __name__ == "__main__":
    main_legacy8() if "--legacy8" in sys.argv else main(with_shipped='--with-shipped' in sys.argv)
