#!/usr/bin/env python3
"""
Fig 4b -- held-out reprojection error vs the number of cameras in the solve, BOTH
LUC3D solvers. REFERENCE-FREE.

The figure's headline: on this rig accuracy is set by how many cameras contribute,
not by the choice of solver. Both solvers improve monotonically as views are added,
and the two curves stay within ~0.2 px of each other at every k.

THE AXIS CHANGED FROM mm TO px, AND THAT WAS FORCED BY A MEASUREMENT.
---------------------------------------------------------------------
This panel used to plot 3D distance to the proofread reference. That axis cannot
compare two solvers, and `figs/fig4_move_geometry.mjs` is the proof rather than the
assertion. Per keypoint, with D = DLT, R = refined, G = reference:

    k = 5:  |D-G| 1.214 mm   |R-D| 1.249 mm   |R-G| 1.852 mm   cos(R-D, G-D) 0.066
    k = 2:  |D-G| 2.697 mm   |R-D| 0.559 mm   |R-G| 2.895 mm   cos 0.002

The refinement MOVES about as far as the reference sits from the DLT, in a direction
essentially UNCORRELATED with the direction to the reference. Adding a displacement
orthogonal to an existing error always increases the distance: the perpendicular
prediction at k = 2 is 2.917 mm against 2.895 measured. So the mm axis was reporting
"the refinement moved" and reading it out as "the refinement is worse", whichever way
it moved -- an arithmetic certainty, not a measurement.

It also rules out the opposite reading. A solver genuinely trading 3D accuracy for 2D
fit would move systematically AWAY from truth: cos well below zero, |R-G| approaching
|D-G| + |R-D| = 2.463 mm at k = 5. Measured 1.852, cos slightly POSITIVE. The
refinement is not wrecking the 3D; the reference cannot see what it did.

WHAT IS PLOTTED NOW. Solve from k of the five cameras (every C-choose-k subset),
project into each camera OUTSIDE the subset, and score against that camera's RAW
DETECTION in its native, still-distorted pixels. No reference 3D enters it, and
neither solver optimises it -- the refinement minimises reprojection error in the
views it WAS given, never the held-out one. That makes this a genuine out-of-sample
test, and it is the metric on which the two solvers can actually be ranked.

**k STOPS AT 4, and that is a hard limit of a five-camera rig, not a choice**: at
k = 5 there is no camera left to hold out. The old mm axis reached k = 5, so the
"3.9x from two to five views" span is not available here; the reference-free span is
2 -> 4. Both are in the caption, each labelled with what it can support.

The px effect is smaller than the old mm effect for a real reason, not because the
measurement got worse: held-out reprojection error has a floor set by the detector's
own noise in the held-out view, which no solve can remove.

Source: figs/out/fig4_by_views.json `heldout_px_across_sessions[k].{dlt,ba}`, written
by figs/fig4_by_views.mjs with the REAL branch solvers. The same file's
`err3d_mm_across_sessions` carries the old mm arm, deposited and deliberately not
plotted.

NOT fig2.json's `by_anchor_count`, despite the similar name: that arm scores against
the REPROJECTED REFERENCE (`gtk`, "3D-consistent target"), so it inherits the
reference's error and is not reference-free.

Each session contributes its own p25/p50/p75 and this panel plots the ACROSS-SESSION
median of each, so the band is the typical session's IQR rather than a pooled spread
that would hide the between-session variation. (`fig4.json`'s `heldout_by_views` is
the pooled version of a similar measurement and runs ~5-10% lower; it pools over
keypoints instead of sessions and holds out one fixed camera rather than scoring
every camera outside the subset. Same story, different estimator -- do not mix the
two sets of numbers.)

    python3 figs/panels/fig4_02_accuracy_vs_cameras.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, deposit, entity, footnote, panel,  # noqa: E402
                       save, use)

#: Set-wide entity colours -- see the note in `fig4_01_solvers.py`. This panel used
#: PINK for its single curve, which is the Fig-2-provenance hue; with two solvers on
#: it, the curves have to carry the same meaning they carry in d and e or a reader
#: learns one mapping per panel.
SOLVERS = [("dlt", "DLT", entity("dlt")), ("ba", "refined", entity("refined"))]


def build() -> pd.DataFrame:
    j = load("fig4_by_views.json")
    a = j["heldout_px_across_sessions"]
    rows = []
    for k in sorted(int(x) for x in a):
        g = a[str(k)]
        row = {"cameras": k}
        for key, _, _ in SOLVERS:
            row[f"{key}_p25"] = g[key]["p25"]
            row[f"{key}_p50"] = g[key]["p50"]
            row[f"{key}_p75"] = g[key]["p75"]
        row["n_sessions"] = g["dlt"]["n_sessions"]
        row["n_values"] = g["dlt"]["n_values"]
        row["ratio_ba_over_dlt"] = row["ba_p50"] / row["dlt_p50"]
        # The EFFECTIVE keypoint stride, read from the run rather than typed in: the
        # footnote used to say "stride 240" (a stride-60 export sampled every 4th
        # keypoint) and would have gone on saying so after the run got denser.
        row["stride"] = j["export_stride"] * j["stride_within_export"]
        row["keypoints_used"] = j["keypoints_used"]
        rows.append(row)
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 4, "fig4b_accuracy_vs_cameras.csv")

    fig, ax = panel("third", "std")
    for key, _, color in SOLVERS:
        # ONE BAND ONLY, the DLT's. Two overlapping 18%-alpha ribbons read as three
        # bands of four tints and neither curve's own spread stays legible. The
        # refinement's IQR is deposited in the CSV and is the same shape; the drawn
        # band belongs to the curve the span is quoted for.
        if key == "dlt":
            # THE DLT IQR BAND IS GONE (review 2026-08-14): the same measurement's
            # per-session spread is now Fig 2c's boxes and dots, and drawing it twice
            # invited "why do these disagree" for two renderings of one deposit. This
            # panel keeps what is UNIQUE to it -- the refined arm and the crossing.
            _band_dropped = True
            if False:
                ax.fill_between(df.cameras, df[f"{key}_p25"], df[f"{key}_p75"],
                            color=color, alpha=0.18, lw=0)
        ax.plot(df.cameras, df[f"{key}_p50"], color=color, lw=2.0, zorder=3)
        ax.plot(df.cameras, df[f"{key}_p50"], "o", color=color, ms=5, mec="white",
                mew=1.0, zorder=4)

    ks = list(df.cameras)
    ax.set_xlim(ks[0] - 0.72, ks[-1] + 0.72)
    # END LABELS written horizontally OUTWARD from the end markers -- the one region
    # next to a marker the ribbon cannot reach, since `fill_between` spans exactly the
    # plotted k range. The x limits are widened to make that margin real rather than
    # letting the labels sit on the spine. The limits move; no number and no datum does.
    # STAGGERED VERTICALLY, because the two curves are 0.11 px apart at k = 2 and
    # 0.19 px at k = 4 -- close enough that labels placed at their own y values
    # overlapped 72% and 54%. Each label is pushed in the direction its curve sits
    # relative to the other, so the pair reads in the same order as the curves and the
    # offset itself carries which is which. The anchor point does not move.
    for end, x, dx, ha in ((0, ks[0], -6, "right"), (-1, ks[-1], 6, "left")):
        vals = {key: df[f"{key}_p50"].iloc[end] for key, *_ in SOLVERS}
        top = max(vals, key=vals.get)
        for key, _, color in SOLVERS:
            dy = 5 if key == top else -5
            ax.annotate(f"{vals[key]:.2f}", (x, vals[key]),
                        textcoords="offset points", xytext=(dx, dy), ha=ha,
                        va="center", color=color, fontweight="bold", fontsize=6)

    lo_y = min(df[f"{k}_p25"].min() for k, *_ in SOLVERS)
    hi_y = max(df[f"{k}_p75"].max() for k, *_ in SOLVERS)
    # NOT ZERO-BASED. A reprojection floor set by detector noise means zero is not a
    # reachable value and anchoring there compresses the whole effect into the top
    # third of the panel. The axis starts below the lowest p25 drawn.
    ax.set_ylim(max(0.0, lo_y - 0.35), hi_y * 1.16)

    for i, (key, name, color) in enumerate(SOLVERS):
        s = df[f"{key}_p50"].iloc[0] / df[f"{key}_p50"].iloc[-1]
        ax.text(ks[-1] + 0.62, hi_y * (1.13 - 0.055 * i), f"{s:.2f}× {name}",
                ha="right", va="top", fontweight="bold", color=color, fontsize=6)

    # THE CROSSING IS THE RESULT, so it is named. The refinement is WORSE than the DLT
    # at two views and better at three and four -- a sign flip, which is the one thing
    # a rigged metric cannot produce and therefore the strongest evidence this axis is
    # measuring the solvers rather than itself.
    #
    # BELOW THE BAND, ON ONE LINE. The two-line version sat inside the DLT ribbon at
    # 91% inked. The ribbon's lower edge falls from 2.63 px at k = 2 to 2.06 at k = 4
    # while the axis starts at ~1.56, so the strip under it is the only region clear
    # at EVERY k -- and it is only ~0.5 px tall, which is why this is one short line
    # rather than two.
    y0 = max(0.0, lo_y - 0.35)
    # The crossing sentence ("refined worse at 2 views, better at 3-4") moved to the
    # legend (review round 3) -- the same prose class the 7a purge removed, and the
    # crossing is visible in the two curves. 5.4 pt was also under Nature's 5 pt
    # floor once print-scaled.

    ax.set_xticks(ks)
    ax.set_xlabel("cameras in the solve")
    ax.set_ylabel("error in a camera it\nnever saw (px)")

    # THE PROTOCOL AND THE BAND, both on the axis, because both are read wrongly by
    # default. "band: median session p25-p75" is the ACROSS-SESSION median of each
    # session's own p25/p50/p75 -- neither a confidence interval on the plotted median
    # nor any one session's IQR, and an unnamed ribbon is read as the former.
    footnote(ax, f"all C-choose-k subsets · stride {int(df.stride.iloc[0])}\n"
                 "same held-out measurement as Fig 2c")
    save(fig, 4, "b", "accuracy_vs_cameras")


if __name__ == "__main__":
    main()
