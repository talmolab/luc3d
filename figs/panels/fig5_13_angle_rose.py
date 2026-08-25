#!/usr/bin/env python3
"""
Fig 5d (RETIRED 2026-08-21, not currently placed -- kept in the tree, still
deposits its CSV, easy to re-wire: change assemble.py's LAYOUTS[5] "d" slug back
to "angle_rose" and re-run this file). Swapped back out for the male/female speed
time course (figs/panels/fig5_09_upright_velocity.py) at Eric's request, after
the wall-distance panel that had occupied 5d before this one was ALSO retired --
see that panel's history for the full sequence 5d has been through.

During the display itself, his head stays pointed at her; hers does not.

ROSE PLOTS OF RELATIVE HEAD/BODY ANGLE. `rel_head_deg`/`rel_body_deg`
(figs/fig5_upright.py) are, for every frame of every display, each animal's own
HEAD (Nose -> Neck) and BODY (Neck -> TTI) axis angle relative to the direction TO
ITS PARTNER: 0 degrees = pointed straight at the partner, +-180 = pointed straight
away. Two different anatomical references on purpose -- the head can turn
independently of the trunk.

THE FINDING. Pooled over all 70,132 display-frames: the MALE's head is tightly
concentrated near 0 degrees (circular mean +0.4 degrees, 55% of frames within
+-30 degrees, 89% within +-60) -- he keeps his head pointed at her essentially the
whole time they are both reared and close, not just in the approach Fig 5e
measures. The FEMALE's head is far less concentrated (circular mean -18 degrees,
only 12% within +-30, 38% within +-60) -- during the same displays she leads, her
head is not consistently oriented at him. Body-axis angle shows the same asymmetry,
weaker (male 31%/78% within +-30/+-60; female 15%/39%): the head decouples from the
body somewhat for both animals, but the male/female gap survives in both references.

WHAT THIS DOES AND DOES NOT SHOW. Combined with Fig 5e (he orients-and-approaches
before onset), this shows the orientation asymmetry does not end at contact -- he
continues facing her through the display itself, more than she faces him. It does
NOT show what she IS doing with her attention (looking elsewhere, or simply not
needing to fixate since she is the one being approached) -- that needs a measure of
what she is oriented at, not just whether she is oriented at him, which this panel
cannot distinguish from "oriented at something else in particular" vs "unoriented".

Source: figs/out/fig5_upright.json `angle_hist.{head_t0,head_t1,body_t0,body_t1}`,
        `angle_bin_edges_deg` (figs/fig5_upright.py).

    python3 figs/panels/fig5_13_angle_rose.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, grid, save, use  # noqa: E402

CM, CFEM = "#4393C3", "#D6604D"      # male, female -- matches every other fig5 panel

PANELS = [("head_t0", "head_t1", "head"), ("body_t0", "body_t1", "body")]


def main():
    use()
    d = load("fig5_upright.json")
    edges = np.radians(np.asarray(d["angle_bin_edges_deg"], float))
    centers = (edges[:-1] + edges[1:]) / 2
    width = edges[1] - edges[0]

    rows = []
    for key, arr in d["angle_hist"].items():
        counts = np.asarray(arr, float)
        p = counts / counts.sum()
        rows.append(pd.DataFrame({"series": key, "bin_center_deg": np.degrees(centers),
                                  "probability": p}))
    deposit(pd.concat(rows, ignore_index=True), 5, "fig5d_angle_rose.csv")

    # THIRD, not two-thirds: this sat in the (c, d, e) row with two other "third"
    # panels -- two-thirds made the row 240 mm on a 180 mm page. At this width (two
    # polar plots in ~57 mm) full titles/tick labels collided; both are as short as
    # they can be and still say what 0 degrees means, and "male"/"female" is a
    # figure-level caption line instead of an in-panel legend (there was no space
    # left that did not sit on top of a bar).
    fig, axes = grid(1, 2, span="third", row="std", despine=False,
                     subplot_kw={"projection": "polar"})
    for ax, (k0, k1, title) in zip(axes, PANELS):
        for key, col in ((k0, CM), (k1, CFEM)):
            counts = np.asarray(d["angle_hist"][key], float)
            p = counts / counts.sum()
            ax.bar(centers, p, width=width * 0.95, color=col, alpha=0.55,
                   edgecolor=col, lw=0.5, zorder=2)
        ax.set_theta_zero_location("N")
        ax.set_theta_direction(-1)
        ax.set_title(title, fontsize=6.5, color=INK, pad=2)
        ax.set_xticks(np.radians([0, 90, 180, 270]))
        ax.set_xticklabels(["0°", "90°", "180°", "-90°"], fontsize=5)
        ax.tick_params(axis="y", labelsize=4, colors="#888888", pad=1)
        ax.set_rlabel_position(135)

    # ONE NOTE for what 0 degrees means, below BOTH polar axes at the figure level
    # (not per-axis) -- placed on one axis first and it collided with that axis's
    # own "180°" tick label, which sits at its own fixed offset below the circle.
    fig.text(0.5, 0.01, "0° = toward partner", ha="center", va="bottom",
             fontsize=5, color="#888888", transform=fig.transFigure)
    fig.text(0.5, 0.985, "male", ha="right", va="top", fontsize=6.5,
             fontweight="bold", color=CM, transform=fig.transFigure)
    fig.text(0.52, 0.985, "/ female", ha="left", va="top", fontsize=6.5,
             fontweight="bold", color=CFEM, transform=fig.transFigure)
    save(fig, 5, "d", "angle_rose")


if __name__ == "__main__":
    main()
