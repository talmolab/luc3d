#!/usr/bin/env python3
"""
Fig 6b -- the mean proofread pose, and the scale of the animal.

The generalised-Procrustes median of 1,802 complete proofread poses. Nose-to-trunk
comes out at 64.5 mm, which independently agrees with the ~67 mm median bone length
measured for Fig 2 from a different pipeline -- worth stating, because it is the only
external check on the metric scale of the whole corpus.

WHY IT MATTERS TO THE OTHER FIGURES. Every millimetre quoted elsewhere is a fraction
of this: Fig 2's "two anchors cost ~3.5 mm" is ~5% of a nose-to-trunk length, and
Fig 4c's 7.2 mm outlier displacement is ~11%. Without the animal's own scale on the
page those numbers have no referent.

Drawn as the skeleton graph in two orthogonal projections, at one stroke weight,
with a scale bar. No shading, no perspective: this is a ruler, not a rendering.

Source: figs/out/fig6.json `mean_pose`.

    python3 figs/panels/fig6_02_pose.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import grid, GREY, INK, TEAL, deposit, save, use  # noqa: E402

VIEWS = [((0, 1), "top (x–y)"), ((0, 2), "side (x–z)")]


def main():
    use()
    mp = load("fig6.json")["mean_pose"]
    xyz = np.asarray(mp["xyz_mm"], float)
    edges = mp["edges"]
    names = mp["node_names"]

    deposit(pd.DataFrame({"node": names, "x_mm": xyz[:, 0], "y_mm": xyz[:, 1],
                          "z_mm": xyz[:, 2]}), 6, "fig6b_pose.csv")

    fig, axes = grid(1, len(VIEWS), span="half", row="std", despine=False)
    for ax, ((i, j), label) in zip(np.atleast_1d(axes), VIEWS):
        for a, b in edges:
            ax.plot([xyz[a, i], xyz[b, i]], [xyz[a, j], xyz[b, j]], color=TEAL,
                    lw=1.4, zorder=2, solid_capstyle="round")
        ax.plot(xyz[:, i], xyz[:, j], "o", color=TEAL, ms=3.5, mec="white",
                mew=0.7, zorder=3)
        ax.set_aspect("equal")
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        ax.set_xlabel(label, color=GREY, fontsize=7)

    # A 20 mm scale bar on the first view, so the panel is a ruler.
    ax0 = np.atleast_1d(axes)[0]
    x0, x1 = ax0.get_xlim()
    y0, y1 = ax0.get_ylim()
    bx, by = x0 + 0.06 * (x1 - x0), y0 + 0.06 * (y1 - y0)
    ax0.plot([bx, bx + 20.0], [by, by], color=INK, lw=1.6,
             solid_capstyle="butt", clip_on=False)
    ax0.text(bx + 10.0, by + 0.02 * (y1 - y0), "20 mm", ha="center", va="bottom",
             color=INK, fontsize=6.5)

    fig.text(0.5, 0.01,
             f"generalised-Procrustes median of {mp['poses_used']:,} proofread "
             f"poses · nose-to-trunk {mp['nose_to_trunk_mm']:.1f} mm",
             ha="center", va="bottom", color=GREY, fontsize=6.5)
    fig.subplots_adjust(wspace=0.06, bottom=0.16)
    save(fig, 6, "s2", "mean_pose")


if __name__ == "__main__":
    main()
