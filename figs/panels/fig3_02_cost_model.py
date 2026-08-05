#!/usr/bin/env python3
"""
Fig 3b -- what exhaustive multi-view association costs, and what the greedy solve costs.

CREDIT WHERE IT IS DUE. The exhaustive method is Maree, Afshar, Oline, Leonardis,
Falkner & Pereira (2024), "Multi-view triangulation-enabled annotation for
multi-animal 3D pose in SLEAP", Proc. Measuring Behavior 2024, 217-224: enumerate
every grouping of instances into identities, triangulate and reproject each, keep
the lowest-reprojection grouping. Its cost is (A!)^C hypotheses per frame for A
animals and C cameras -- A! per view, raised to the number of views. That paper's
own "Future directions ▸ Faster multi-view association" proposes the GREEDY variant
which hard-commits each view's assignment, and that is exactly what LUC3D's
per-view Hungarian does. So this panel answers a question that paper poses.

LUC3D's cost is one Hungarian solve per camera per frame: O(C · A^3), which on this
axis is flat next to (A!)^C.

The curves are ANALYTIC -- they are the closed-form hypothesis counts, not timings.
Panel c carries the measured runtime. Keeping them apart matters: an analytic count
and a wall-clock measurement have different failure modes and must not share an axis.

Source: figs/out/fig3_runtime.json `analytic_exhaustive`.

    python3 figs/panels/fig3_02_cost_model.py
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, SALMON, SET2, deposit, footnote,  # noqa: E402
                       panel, save, text_legend, use)

CAMERAS = [2, 4, 6, 8]
ANIMALS = list(range(1, 7))


def build() -> pd.DataFrame:
    load("fig3_runtime.json")          # provenance: same run the measured panel uses
    rows = []
    for c in CAMERAS:
        for a in ANIMALS:
            rows.append({
                "cameras": c, "animals": a,
                "exhaustive": math.factorial(a) ** c,
                "greedy": c * a ** 3,
            })
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 3, "fig3b_cost_model.csv")

    # key=5, NOT key=2. The band panel() reserves has to match the number of entries
    # actually stacked in it: at key=2 the 3rd and 4th camera entries fell out of the
    # band and landed on the 10^20 tick label and the top of the plot.
    fig, ax = panel("third", "std", key=5)
    for i, c in enumerate(CAMERAS):
        g = df[df.cameras == c]
        ax.plot(g.animals, g.exhaustive, color=SET2[i], lw=2.0, zorder=3)
        ax.plot(g.animals, g.exhaustive, "o", color=SET2[i], ms=4, mec="white",
                mew=0.8, zorder=4)

    g = df[df.cameras == CAMERAS[-1]]
    ax.plot(g.animals, g.greedy, color=GREY, lw=2.0, ls=(0, (2.5, 1.5)), zorder=3)

    # A tractability rule, so the axis has a meaning a reader can act on.
    ax.axhline(1e6, color=SALMON, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)

    # NO TEXT INSIDE THESE AXES, and that is deliberate rather than timid. Six curves
    # over 20 decades leave no gap wide enough for a label: "LUC3D (greedy)" pinned
    # above its own dashed curve lay across the 10^6 rule and the 2-camera stroke, and
    # "10^6 hypotheses/frame" is ~90 pt of type on a ~110 pt axis, so at the one height
    # it belongs -- just above the rule -- the 8-, 6- and 4-camera curves punch through
    # it at A = 3.0, 3.4 and 4.2. Both are therefore named outside the axes instead --
    # the greedy curve from the key band, the rule from the footnote -- and colour
    # carries the match, which is unambiguous here: one grey dash, one salmon dot.
    text_legend(ax, [(f"{c} cameras", SET2[i]) for i, c in enumerate(CAMERAS)]
                + [("LUC3D (greedy)", GREY)], "above")
    ax.set_yscale("log")
    ax.set_xticks(ANIMALS)
    ax.set_xlabel("animals")
    ax.set_ylabel("hypotheses per frame")
    ax.set_ylim(1, 1e20)
    ax.set_yticks(np.logspace(0, 20, 6))
    # AFTER set_xlabel, not before: footnote() APPENDS to the current x label, so a
    # later set_xlabel silently throws the note away.
    footnote(ax, "salmon rule: 10⁶ hypotheses/frame")
    save(fig, 3, "b", "cost_model")


if __name__ == "__main__":
    main()
