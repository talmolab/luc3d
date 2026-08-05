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
from src.style import (GREY, SALMON, SET2, annotate_series, deposit,  # noqa: E402
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

    fig, ax = panel("third", "std", key=2)
    for i, c in enumerate(CAMERAS):
        g = df[df.cameras == c]
        ax.plot(g.animals, g.exhaustive, color=SET2[i], lw=2.0, zorder=3)
        ax.plot(g.animals, g.exhaustive, "o", color=SET2[i], ms=4, mec="white",
                mew=0.8, zorder=4)

    g = df[df.cameras == CAMERAS[-1]]
    ax.plot(g.animals, g.greedy, color=GREY, lw=2.0, ls=(0, (2.5, 1.5)), zorder=3)
    # Bottom-right, in axes coords: at the curve's own height this label lay across
    # the 4- and 6-camera exhaustive strokes.
    # Pinned just above the right end of its OWN curve, in data coords, so it can
    # never drift onto it -- a fixed axes-corner position crossed the dashed line.
    ax.annotate("LUC3D (greedy)", (ANIMALS[-1], g.greedy.iloc[-1]),
                textcoords="offset points", xytext=(-2, 7), ha="right",
                va="bottom", color=GREY, fontweight="bold", fontsize=7)

    # A tractability rule, so the axis has a meaning a reader can act on.
    ax.axhline(1e6, color=SALMON, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    ax.text(ANIMALS[-1], 1.6e6, "10⁶ hypotheses/frame", color=SALMON, fontsize=7,
            va="bottom", ha="right")

    text_legend(ax, [(f"{c} cameras", SET2[i]) for i, c in enumerate(CAMERAS)],
                "above")
    ax.set_yscale("log")
    ax.set_xticks(ANIMALS)
    ax.set_xlabel("animals")
    ax.set_ylabel("hypotheses per frame")
    ax.set_ylim(1, 1e20)
    ax.set_yticks(np.logspace(0, 20, 6))
    save(fig, 3, "b", "cost_model")


if __name__ == "__main__":
    main()
