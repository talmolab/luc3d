#!/usr/bin/env python3
"""
Fig 7f -- wall clock to calibrate a session, detection and solve, both tools.

WHY THIS PANEL IS HONEST ABOUT ITS OWN HANDICAP. Anipose's detector is serial; ours
runs a pool of browser workers. Comparing 1 core against 12 would be a statement
about the hardware, so Anipose is run here with ONE PROCESS PER CAMERA (8 and 18 of
them) and its bar is that PARALLEL wall clock -- the best case for Anipose on this
machine, not the number its stock serial loop would give. The summed single-core time
is deposited beside it in the CSV, and it is several times larger.

DETECTION AND SOLVE ARE STACKED, NOT SUMMED AWAY, because they are the two halves a
reader trades off differently: detection scales with frames x cameras and is
embarrassingly parallel, while the solve is a single optimisation whose cost is
superlinear in frames. Anipose spends almost all of its time in detection; calibrat3
spends a third of its time in a bundle adjustment Anipose also runs.

THE TWO TOOLS ARE NOT LOOKING AT THE SAME NUMBER OF FRAMES, and that is the honest
shape of the comparison rather than a flaw in it: calibrat3's default samples the
session, Anipose's `detect_video` covers every board-visible frame on an adaptive
skip schedule. Panel f is what licenses reading this panel as a speed result -- it
shows calibrat3 reaches the same error on every frame as on its sample, so the time
saved is not accuracy spent. The frames each tool actually detected on are in the
deposited CSV.

LINEAR AXIS, WHICH A STACKED BAR REQUIRES. The first draft used a log y, on the
grounds that the tools might differ by an order of magnitude -- but a stack drawn on a
log axis is simply wrong: the detection segment is measured from the axis floor rather
than from zero, so the two segments' heights are not their values and their ratio is
not their ratio. The measured range across both tools and both rigs is under 5x, which
a linear axis carries without either bar becoming a line of pixels, and the total is
printed above each bar so the quantity is readable and not merely comparable.

    python3 figs/panels/fig7_02_runtime.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig7_common import ARM_COLOR, DATASETS, MAIN_C3  # noqa: E402
from matplotlib.colors import to_rgba  # noqa: E402
from src.data_loader import load  # noqa: E402
from src.style import MUTED, deposit, panel, save, text_legend, use  # noqa: E402

#: (tool key, printed name). calibrat3's bar is its DEFAULT sampling -- the same arm
#: every other panel scores -- so the time and the accuracy on this figure belong to
#: one run and not to two different configurations.
TOOLS = [("calibrat3", "calibrat3"), ("anipose", "Anipose")]

#: frames in each session, for the tick labels -- the other variable the time scales
#: with, and the one that says why the 8-camera bar is not simply the smaller job.
FRAMES = {"cal_test2": 2701, "calib18": 1800}
OFFSET = {"calibrat3": -0.19, "anipose": 0.19}
WIDTH = 0.34


def parts(ds, tool):
    """(detection s, solve s) as each tool reported it for itself."""
    t = ds["timing"]
    if tool == "calibrat3":
        d = t[MAIN_C3]["timing"]
        # load is the browser opening 8-18 mp4s; it is under 2 s and belongs to
        # neither half, so it goes into the solve column rather than vanishing.
        return d["detection_s"], d["intrinsics_s"] + d["extrinsics_s"] + d["sba_s"] + d["load_s"]
    a = t["anipose"]
    return a["detection_s_wall"], a["calibration_s"]


def main():
    use()
    rec = load("fig7_calibration.json")
    # QUARTER: four bars and two group labels fit; see the layout note in assemble.py.
    fig, ax = panel("quarter", "std", key=2)

    rows, tops = [], []
    for gi, (dskey, dsname, ncam) in enumerate(DATASETS):
        ds = rec["datasets"].get(dskey)
        if ds is None:
            continue
        for tool, tname in TOOLS:
            det, sol = parts(ds, tool)
            x = gi + OFFSET[tool]
            color = ARM_COLOR[tool]
            # DETECTION IS THE PALE HALF, the solve the saturated one: detection is
            # the part that is merely parallel work, the solve is the part that is a
            # method. Same hue, so the bar still reads as one tool.
            ax.bar(x, det, WIDTH, color=to_rgba(color, 0.45), edgecolor=color, lw=0.7, zorder=2)
            ax.bar(x, sol, WIDTH, bottom=det, color=to_rgba(color, 0.95),
                   edgecolor=color, lw=0.7, zorder=2)
            tops.append((x, det + sol, color))
            cpu = ds["timing"]["anipose"].get("detection_s_cpu") if tool == "anipose" else None
            rows.append({"dataset": dskey, "cameras": ncam, "tool": tool,
                         "detection_s": det, "solve_s": sol, "total_s": det + sol,
                         "anipose_detection_s_single_core": cpu})

    hi = max(t for _, t, _ in tops)
    for x, top, color in tops:
        ax.text(x, top + hi * 0.03, f"{top:.0f}", ha="center", va="bottom", fontsize=7,
                fontweight="bold", color=color)

    ax.set_ylim(0, hi * 1.35)
    ax.set_ylabel("wall clock (s)")
    ax.set_xticks(range(len(DATASETS)))
    # The rig is named by its camera count and its frame count, which are the two
    # things the time scales with; the session's internal key means nothing to a
    # reader and "8-camera rig / 8 cameras" (what this line built before) said the
    # same thing twice.
    # ABBREVIATED, because the panel is a quarter of the page: "2701 frames" and
    # "1800 frames" at 7 pt are wider than the 21 mm each group gets and ran together.
    ax.set_xticklabels([f"{c} cam\n{FRAMES[k]} fr" for k, _, c in DATASETS], fontsize=6.5)
    ax.set_xlim(-0.6, len(DATASETS) - 0.4)
    ax.tick_params(axis="x", length=0, pad=2.0)
    text_legend(ax, [(t, ARM_COLOR[k]) for k, t in TOOLS], loc="above")
    # The pale/solid split is a second encoding and needs naming once; it goes inside
    # the axes at the left, where both groups are short.
    ax.text(0.02, 0.98, "solid: solve\npale: detection", transform=ax.transAxes,
            fontsize=6.5, color=MUTED, va="top", ha="left")

    df = pd.DataFrame(rows)
    deposit(df, 7, "fig7f_runtime.csv")
    save(fig, 7, "f", "runtime")


if __name__ == "__main__":
    main()
