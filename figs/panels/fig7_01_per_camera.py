#!/usr/bin/env python3
"""
Fig 7b/7d -- reprojection error per camera, calibrat3 beside Anipose.

WHY A PER-CAMERA BREAKDOWN EARNS ITS OWN PANEL. A pooled distribution (a, c) can be
carried by the well-placed cameras: a rig of eighteen is calibrated as a CHAIN, and
the cameras at the ends of that chain are the ones that go wrong. A pooled median
averages them away; a column per camera shows exactly which view a tool loses, and
whether the losses are one bad camera or a uniform shift. On the 18-camera rig this
is the panel that decides whether a tool is usable, because a single camera at 8 px
is enough to ruin every triangulation that uses it.

BOXES, NOT DOTS. The unit here is the OBSERVATION and there are 10^4-10^6 of them per
camera, so there is nothing to scatter -- the box IS the distribution: median, IQR,
and whiskers, computed on the full array by the measurement pass and drawn with `bxp`
rather than re-estimated from a subsample.

WHISKERS ARE p5-p95, NOT 1.5 IQR, and at this sample size that is the correct choice
rather than a softer one. Tukey's fence is an outlier rule for samples of tens; over
10^5 observations it flags tens of thousands of points, and because reprojection
error is strictly positive its LOWER fence lands below zero -- so the lower whisker
stopped being a statistic at all and simply reached the smallest error in the
session, ~10^-4 px. Drawn on the log axis this panel needs, that turned every column
into a 5-decade spike and buried the comparison the panel exists to make. p5-p95 is
where the middle 90 % of that camera's observations fall, and its top is the same p95
the rest of the figure quotes.

NO FLIERS. `fig2_15`'s rule is that fliers come back when the individual observations
are no longer drawn -- but that rule is about 50 SESSIONS, where a flier is one
recording a reader might want to identify. Here a flier would be one of ~10^6 corner
observations, and drawing them puts a solid band of ink over every box. The tail is
not lost: it is what panels a and c are for, and the p99 per camera is in the CSV.

LOG Y, because the quantity being compared is a RATIO. Across the 18-camera rig the
per-camera medians run from about 0.25 px (calibrat3's best) to 3.5 px (Anipose's
worst), and the p95 whiskers reach further; on a linear axis the low half of the panel
-- where calibrat3's whole distribution lives -- is compressed into a few points of ink,
and a factor of two reads differently at the top of the axis than at the bottom. On a
log axis a constant factor is a constant distance, which is what lets a reader see that
the gap holds on every camera rather than being carried by the worst one.

CAMERAS ARE ORDERED AS THE RIG NAMES THEM, not by error. Sorting by error would make
the two arms' x axes disagree (each tool loses a different camera), and the reader
could no longer ask "what happened to Camera 7".

    python3 figs/panels/fig7_01_per_camera.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig7_common import ARM_COLOR, ARM_LABEL, MAIN_C3, MAIN_DETSET  # noqa: E402
from matplotlib.colors import to_rgba  # noqa: E402
from src.data_loader import load  # noqa: E402
from src.style import MUTED, deposit, panel, save, text_legend, use  # noqa: E402

LETTERS = {"cal_test2": "b", "calib18": "d"}

#: (letter, slug) this script draws, spelled as literals -- see the note in
#: `fig7_00_error_cdf.py` for why a computed `save()` needs them.
PANELS = [("b", "per_camera_cal_test2"), ("d", "per_camera_calib18")]


#: TWO ARMS HERE, THREE IN a/c. The solver-on-our-corners arm is the figure's
#: mechanism question and it is answered by the pooled curves; per camera it would be
#: a 54th box on the 18-camera panel, at which width nothing is readable. What this
#: panel is for is which CAMERA each tool loses, and that needs the two end-to-end
#: arms only.
ARMS = ["calibrat3", "anipose"]

#: Offsets within a camera's slot, and the box width. The pair has to read as a pair:
#: at 0.42 apart with width 0.34 the two boxes touch at their whiskers and separate
#: slots stay clearly apart.
OFFSET = {"calibrat3": -0.20, "anipose": 0.20}
WIDTH = 0.34


def arm_stats(ds, arm):
    return ds["detsets"][MAIN_DETSET]["arms"][MAIN_C3 if arm == "calibrat3" else arm]


def draw(dskey, ds):
    cams = ds["cameras"]
    # TWO-THIRDS FOR BOTH RIGS, though eight cameras would fit in a third. Rows 1 and
    # 2 of this figure are the same comparison on two rigs, so they are built the same
    # way -- CDF at a third, per-camera at two-thirds -- and the reader's eye can move
    # straight down from one rig's camera column to the other's.
    fig, ax = panel("two-thirds", "std", key=2)

    rows = []
    for arm in ARMS:
        st = arm_stats(ds, arm)
        color = ARM_COLOR[arm]
        bxp = []
        for i, cam in enumerate(cams):
            c = st["cameras"][cam]
            bxp.append(dict(med=c["med"], q1=c["q1"], q3=c["q3"],
                            whislo=c["whislo"], whishi=c["whishi"], fliers=[],
                            label=cam))
            rows.append({"dataset": dskey, "camera": cam, "arm": arm, "n": c["n"],
                         "q1": c["q1"], "median": c["med"], "q3": c["q3"],
                         "whislo": c["whislo"], "whishi": c["whishi"],
                         "mean": c["mean"], "p95": c["p95"], "p99": c["p99"]})
        # patch_artist=True: without it bxp draws the box as a Line2D and silently
        # refuses the facecolor, so the panel comes out as outlines.
        ax.bxp(bxp, positions=[i + OFFSET[arm] for i in range(len(cams))],
               widths=WIDTH, showfliers=False, manage_ticks=False, zorder=2,
               patch_artist=True,
               # WHITE MEDIAN ON A FILLED BOX -- the house rule. At these box heights
               # the median is the only mark a reader can compare across arms, so it
               # has to survive the fill.
               medianprops=dict(color="white", lw=1.4),
               boxprops=dict(facecolor=to_rgba(color, 0.85), edgecolor=color, lw=0.7),
               whiskerprops=dict(color=color, lw=0.7),
               capprops=dict(color=color, lw=0.7))

    ax.set_yscale("log")
    ax.set_xlim(-0.6, len(cams) - 0.4)
    # The y label names the whisker convention, because "box and whisker" on a log
    # axis is ambiguous and a reader who assumes Tukey would misread the spread.
    ax.set_ylabel("reprojection error (px)\nbox: IQR · whiskers: p5–p95")
    ax.set_xticks(range(len(cams)))
    # THE 18 RIG'S NAMES ARE "Camera0".."Camera17" -- 7 characters each, and 18 of
    # them do not fit 117 mm. The number alone is unambiguous once the axis says what
    # it counts, which is what the x label is for.
    short = [c.replace("Camera", "") for c in cams] if len(cams) > 10 else cams
    ax.set_xticklabels(short, fontsize=7 if len(cams) > 10 else 8,
                       rotation=0 if len(cams) > 10 else 30,
                       ha="center" if len(cams) > 10 else "right")
    ax.set_xlabel("camera" if len(cams) > 10 else "")
    ax.tick_params(axis="x", length=0, pad=2.0)
    text_legend(ax, [(ARM_LABEL[a], ARM_COLOR[a]) for a in ARMS], loc="above")
    save(fig, LETTERS_FIG, LETTERS[dskey], f"per_camera_{dskey}")
    return pd.DataFrame(rows)


LETTERS_FIG = 7


def main():
    use()
    rec = load("fig7_calibration.json")
    out = [draw(k, rec["datasets"][k]) for k in LETTERS if k in rec["datasets"]]
    deposit(pd.concat(out), 7, "fig7bd_per_camera.csv")


if __name__ == "__main__":
    main()
