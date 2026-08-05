#!/usr/bin/env python3
"""
Fig 7a -- within-view vs cross-view IDF1: which trackers hold identity ACROSS cameras.

THE HEADLINE RESULT OF THE WHOLE FIGURE, and the one my first pass omitted entirely.
A per-camera tracker can score well within a view and still have no idea that
camera 0's animal 1 is camera 3's animal 1. This panel measures exactly that: the
same sessions scored within view, then across views.

LUC3D 0.749 -> 0.749 (x1.00): no drift at all, because cross-view identity is what
it solves. SLEAP per-camera 0.115 -> 0.062 (x0.53) and ByteTrack 0.157 -> 0.046
(x0.29) lose half to three-quarters of their score, because nothing in a per-camera
tracker links views. 3D-MuPPET is flat but at 0.011.

THE CHANCE LINE MATTERS. With C = 5 cameras, randomly pairing identities across
views gives 1/C = 0.2, drawn as a rule: every per-camera tracker's CROSS-view score
sits BELOW chance, which is the point -- their within-view competence does not
transfer at all.

Source: figs/out/fig3_trackers.json `bmimica_50_sessions`.

    python3 figs/panels/fig7_05_within_vs_cross.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, PERIWINKLE, PINK, SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, use)

ORDER = [("LUC3D", TEAL), ("SLEAP per-camera", PERIWINKLE),
         ("ByteTrack", SALMON), ("3D-MuPPET", PINK)]


def main():
    use()
    bm = load("fig3_trackers.json")["bmimica_50_sessions"]
    rows = []
    fig, ax = panel("half", "std")

    # Label y positions are staggered by rank, not taken from the data: three of the
    # four trackers land within 0.05 of each other at the cross-view end and their
    # labels overprinted.
    label_y = [0.86, 0.74, 0.62, 0.50]
    for rank, (name, color) in enumerate(ORDER):
        if name not in bm:
            continue
        w, c = bm[name]["within"]["mean"], bm[name]["cross"]["mean"]
        rows.append({"tracker": name, "within": w, "cross": c,
                     "ratio": c / w if w else float("nan"),
                     "n_sessions": bm[name]["within"]["n_sessions"]})
        ax.plot([0, 1], [w, c], color=color, lw=2.0, zorder=3)
        ax.plot([0, 1], [w, c], "o", color=color, ms=5, mec="white", mew=1.0,
                zorder=4)
        ax.annotate(f"{name}  {w:.3f} → {c:.3f} ×{c / w:.2f}",
                    (1.05, label_y[rank]), color=color, fontsize=6.5,
                    fontweight="bold", va="center", annotation_clip=False)

    df = pd.DataFrame(rows)
    deposit(df, 7, "fig7a_within_vs_cross.csv")

    # Chance for a random cross-view pairing on this rig.
    ncam = 5
    ax.axhline(1 / ncam, color=GREY, lw=0.8, ls=(0, (2.5, 1.5)), zorder=1)
    ax.text(0.0, 1 / ncam + 0.015, f"1/C, C = {ncam}", color=GREY, fontsize=6.5,
            va="bottom")

    ax.set_xlim(-0.15, 1.05)
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["within view", "cross view"])
    ax.set_ylabel("IDF1")
    ax.set_ylim(0, 0.95)
    footnote(ax, f"n = {int(df.n_sessions.iloc[0])} BMimica sessions, "
            f"{ncam} cameras, 2 mice")
    save(fig, 7, "a", "within_vs_cross")


if __name__ == "__main__":
    main()
