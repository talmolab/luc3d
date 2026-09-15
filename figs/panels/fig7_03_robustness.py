#!/usr/bin/env python3
"""
Fig 7s1/7s2 -- the two ways this benchmark could have been rigged, tested.

A calibration benchmark has two free choices that a reader is right to distrust,
because either one can be picked to flatter the tool the authors wrote:

s1 IS NOT PLACED ON THE ARTWORK: it reports a null -- calibrat3 on every frame lands
within 0.01 px of its own 800-frame default on both rigs -- and a null that fits in one
clause does not need 57 mm of a page already three rows tall. Its CSV is deposited and
the legend quotes it. NEITHER IS PLACED in the final layout: the
synthetic ground-truth panel took g, on the grounds that "did it recover the camera"
outranks "which corners was it scored on" when only one slot is free. s2's finding -- the
median ranking flips with the scoring set, the tail does not -- is quoted in the legend
and visible as the crossing in panels a and c.

**s1 -- WHOSE FRAMES.** calibrat3 samples the session (800 frames of 2701 / 1800 by
default). Anipose's `detect_video` walks the whole video on an adaptive schedule --
every 20th frame until the board is found, then every frame for as long as it keeps
being found -- so it covers essentially every board-visible frame. If calibrat3's
sampling were doing the work, if it were quietly being handed an easier subset, then
running it on EVERY frame would move its error. This panel runs it both ways.

**s2 -- WHOSE CORNERS.** Every calibration on this figure is scored on Anipose's own
detections (see `fig7_common.MAIN_DETSET`), which is the choice that cannot flatter
us. This panel re-scores every arm on calibrat3's detections instead.

AND IT IS NOT A NULL RESULT, which is why it is worth drawing: on the 8-camera rig the
MEDIAN ranking FLIPS. Anipose is 0.31 px against calibrat3's 0.42 on Anipose's corners,
and 0.60 against 0.096 on calibrat3's. That is the signature of each solver fitting the
corners it was given -- an in-sample advantage belonging to whichever tool produced the
detection set -- and a benchmark quoting one scoring set would have reported it as a
property of the calibration. The 18-camera rig does not flip (calibrat3 lower on both).

WHAT DOES NOT FLIP IS THE TAIL: calibrat3's p95 is roughly five times lower than
Anipose's on both rigs and on both scoring sets, and that is the claim this figure
actually rests on. An earlier version of this docstring asserted the ranking was
unchanged on either set. It was written before the 8-camera measurement existed and was
wrong.

BOTH PANELS PLOT MEDIANS AS PAIRED DOTS JOINED BY A RULE, not boxes: the quantity
being compared is one number per (arm, session, condition), and what the reader has
to see is whether the line between the two conditions is FLAT. A box would invite a
comparison of spreads that is not the question here -- the spreads are in a-d.

    python3 figs/panels/fig7_03_robustness.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig7_common import ARM_COLOR, ARMS, DATASETS, MAIN_C3, MAIN_DETSET  # noqa: E402
from matplotlib.ticker import FuncFormatter, LogLocator, NullFormatter  # noqa: E402
from src.data_loader import load  # noqa: E402
from src.style import MUTED, deposit, panel, save, text_legend, use  # noqa: E402

#: marker per session, so one panel can carry both rigs without a second hue: colour
#: is spoken for by the tool (the set-wide ENTITY rule) and the session is the
#: secondary encoding.
MARKER = {"cal_test2": "o", "calib18": "s"}

#: Vertical nudge, in points, for the rig label at the end of each line. The two rigs
#: can land at nearly the same error -- that is the RESULT on panel f, where both sit
#: within 0.01 px of their own sampled value -- and two labels at one height overprint
#: into an unreadable smear. Pushing one up and one down costs nothing when they are
#: far apart and saves the panel when they are not.
LABEL_DY = {"cal_test2": 4.5, "calib18": -4.5}


def label_rig(ax, y, ncam, dskey):
    ax.annotate(f"{ncam} cam", (1.04, y), textcoords="offset points",
                xytext=(0, LABEL_DY[dskey]), fontsize=6.5, color=MUTED,
                va="center", ha="left", annotation_clip=False)


def med(ds, detset, arm):
    a = ds["detsets"].get(detset, {}).get("arms", {}).get(arm)
    return None if a is None else a["overall"]["med"]


def paired(ax, series, xticklabels, ylabel):
    """series: [(label, colour, marker, solid?, [y at x=0, y at x=1])]

    `solid` carries the SAME distinction the key does -- one library in two
    configurations shares a hue and is separated by the stroke. It is a parameter and
    not a constant because the key on panel g names a dashed arm, and a key that names
    a stroke the panel never draws is worse than no key at all.
    """
    for _, color, marker, solid, ys in series:
        ax.plot([0, 1], ys, color=color, lw=1.4 if solid else 1.0, zorder=2,
                alpha=0.85, ls="-" if solid else (0, (2.5, 1.5)))
        ax.plot([0, 1], ys, color=color, marker=marker, ms=4.5, lw=0, zorder=3,
                markerfacecolor=color if solid else "white",
                markeredgecolor=color if not solid else "white", markeredgewidth=0.9)
    ax.set_xlim(-0.3, 1.45)
    ax.set_xticks([0, 1])
    ax.set_xticklabels(xticklabels, fontsize=6.5)
    ax.tick_params(axis="x", length=0, pad=2.0)
    ax.set_yscale("log")
    # PLAIN DECIMAL TICKS. These panels span less than one decade, where matplotlib's
    # default log formatter falls back to "6 x 10^-1" -- three glyph groups for one
    # number, on a 57 mm panel, for a quantity a reader wants to compare at a glance.
    # Ticks at 1, 2 and 5 per decade and a %g label print "0.2 0.5 1 2".
    ax.yaxis.set_major_locator(LogLocator(base=10, subs=(1.0, 2.0, 5.0), numticks=12))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
    ax.yaxis.set_minor_formatter(NullFormatter())
    ax.set_ylabel(ylabel)


def frames_panel(rec):
    """f -- calibrat3 at its default sampling vs on every frame."""
    fig, ax = panel("third", "std", key=2)
    rows, series = [], []
    for dskey, dsname, ncam in DATASETS:
        ds = rec["datasets"].get(dskey)
        if ds is None:
            continue
        ys = [med(ds, MAIN_DETSET, MAIN_C3), med(ds, MAIN_DETSET, "calibrat3_all")]
        if ys[1] is None:
            # The every-frame arm was only run on the two rigs the sampling question was
            # asked of; the 8-camera rig's four recordings were measured at the default
            # alone. A dataset without the arm is skipped, not fatal.
            continue
        series.append((dsname, ARM_COLOR["calibrat3"], MARKER[dskey], True, ys))
        nd = ds["timing"][MAIN_C3]["detectionFrames"]
        na = ds["timing"]["calibrat3_all"]["detectionFrames"]
        rows += [{"dataset": dskey, "cameras": ncam, "condition": "sampled",
                  "frames": nd, "median_px": ys[0]},
                 {"dataset": dskey, "cameras": ncam, "condition": "every frame",
                  "frames": na, "median_px": ys[1]}]
        label_rig(ax, ys[1], ncam, dskey)
    paired(ax, series, ["sampled\n(default)", "every\nframe"],
           "reprojection error, median (px)")
    text_legend(ax, [("calibrat3", ARM_COLOR["calibrat3"])], loc="above")
    save(fig, 7, "s1", "frame_budget")
    return pd.DataFrame(rows)


def detset_panel(rec):
    """g -- every arm re-scored on the other tool's detections."""
    fig, ax = panel("quarter", "std", key=3)
    rows, series = [], []
    for dskey, dsname, ncam in DATASETS:
        ds = rec["datasets"].get(dskey)
        if ds is None:
            continue
        # TWO ARMS, not three. The panel is a quarter of the page and its point is
        # whether the calibrat3-against-Anipose ranking depends on whose corners the
        # score is read on; the solver-on-our-corners arm is the mechanism question,
        # which panel e answers, and as a third pair of lines here it only crowds the
        # crossing that is the result. Its numbers stay in the CSV.
        for key, name, color, filled in [a for a in ARMS if a[0] != "anipose_on_ours"]:
            arm = MAIN_C3 if key == "calibrat3" else key
            ys = [med(ds, "anipose", arm), med(ds, "calibrat3", arm)]
            if None in ys:
                # Only the two rigs were scored on BOTH detection sets; the four
                # 8-camera recordings were scored on Anipose's corners alone.
                continue
            series.append((name, color, MARKER[dskey], filled, ys))
            rows += [{"dataset": dskey, "cameras": ncam, "arm": key,
                      "scored_on": "anipose detections", "median_px": ys[0]},
                     {"dataset": dskey, "cameras": ncam, "arm": key,
                      "scored_on": "calibrat3 detections", "median_px": ys[1]}]
            # Name the rig on ITS OWN calibrat3 line, as panel f does, instead of a
            # corner key of marker shapes. A key made the reader carry "square = 18
            # cameras" across six lines, and at the bottom right -- the only corner
            # free of data -- it landed on the teal marker it was meant to explain.
            if key == "calibrat3":
                label_rig(ax, ys[1], ncam, dskey)
    paired(ax, series, ["Anipose\ncorners", "calibrat3\ncorners"],
           "reprojection error, median (px)")
    # NAMED unpack, not `_` twice: `for _, n, c, _ in ARMS if _ != ...` binds `_` to the
    # tuple's LAST field, so the filter tested `filled` and the key kept advertising a
    # dashed arm this panel no longer draws.
    text_legend(ax, [(n, c) for k, n, c, _f in ARMS if k != "anipose_on_ours"],
                loc="above", size=6.5, dy=0.05)
    save(fig, 7, "s2", "scoring_set")
    return pd.DataFrame(rows)


def main():
    use()
    rec = load("fig7_calibration.json")
    deposit(frames_panel(rec), 7, "fig7s1_frame_budget.csv")
    deposit(detset_panel(rec), 7, "fig7s2_scoring_set.csv")


if __name__ == "__main__":
    main()
