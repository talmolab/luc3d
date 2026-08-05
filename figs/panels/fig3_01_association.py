#!/usr/bin/env python3
"""
Fig 3a -- exhaustive vs greedy cross-view association, as the two shapes of the work.

REDRAWN. An earlier version showed two sets of crossing lines between camera columns
and read as noise: the lines encoded the ANSWER, which is not what separates the
methods. What separates them is the SHAPE OF THE SEARCH, so that is what is drawn.

LEFT, exhaustive (Maree, Afshar, Oline, Leonardis, Falkner & Pereira 2024, Proc.
Measuring Behavior 217-224): every grouping of detections into identities is
enumerated, triangulated and scored, and the lowest-reprojection one is kept. The
grid is that hypothesis set -- (A!)^C of them per frame -- with the winner filled.

RIGHT, greedy (LUC3D): one Hungarian assignment per camera, each committing before
the next is considered. The chain is C solves, not (A!)^C hypotheses.

That paper's own "Future directions ▸ Faster multi-view association" proposes exactly
this greedy variant, so the comparison is one it invited.

    python3 figs/panels/fig3_01_association.py
"""
import sys
from pathlib import Path

from matplotlib.patches import FancyArrowPatch, Rectangle

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, icon  # noqa: E402
from src.style import MUTED, GREY, INK, SALMON, TEAL, grid, save, use  # noqa: E402

NCOL, NROW = 8, 3          # the hypothesis grid
WIN = (3, 1)               # which cell is the kept grouping
NCAM = 4


def box(ax, title, sub, accent):
    """The panel's frame, accent bar and two-line heading."""
    ax.add_patch(Rectangle((0, 0), 10, 5.0, fill=False, ec="#DDDDDD", lw=0.8))
    ax.add_patch(Rectangle((0, 0), 0.16, 5.0, facecolor=accent, edgecolor="none"))
    ax.text(0.45, 4.62, title, fontweight="bold", color=INK, fontsize=7.5,
            va="center")
    # 8.0, not 6.5: mathtext superscripts render at ~0.7x, so (A!)$^C$ at
    # 6.5 pt put its C at 4.55 pt -- under Nature's 5 pt floor.
    ax.text(0.45, 4.10, sub, color=MUTED, fontsize=8.0, va="center")


def draw_exhaustive(ax):
    blank(ax)
    ax.set_aspect("auto")
    box(ax, "Exhaustive hypothesis testing", "Maree et al. 2024 · (A!)$^C$ per frame",
        SALMON)
    w, h, gx, gy = 0.95, 0.42, 0.20, 0.22
    x0, y0 = 0.55, 1.55
    for r in range(NROW):
        for c in range(NCOL):
            win = (c, r) == WIN
            ax.add_patch(Rectangle(
                (x0 + c * (w + gx), y0 + r * (h + gy)), w, h,
                facecolor=SALMON if win else "#EEEEEE", edgecolor="none"))
    ax.text(0.45, 1.05, "every grouping triangulated + scored", color=INK,
            fontsize=6.5, va="center")
    ax.text(0.45, 0.55, "one kept: lowest reprojection error", color=SALMON,
            fontsize=6.5, va="center")
    ax.set_xlim(-0.1, 10.1)
    ax.set_ylim(-0.1, 5.1)


def draw_greedy(ax):
    blank(ax)
    ax.set_aspect("auto")
    box(ax, "Greedy per-view assignment", "LUC3D · C Hungarian solves, O(C·A³)", TEAL)
    for i in range(NCAM):
        x = 0.7 + i * 2.35
        icon(ax, "camera", x, 2.75, s=0.62, color=INK)
        ax.add_patch(Rectangle((x, 1.75), 0.72, 0.62, fill=False, ec=TEAL, lw=0.9))
        ax.text(x + 0.36, 2.06, "H", ha="center", va="center", color=TEAL,
                fontsize=7, fontweight="bold")
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x + 0.86, 2.06), (x + 2.2, 2.06),
                                         arrowstyle="-|>", mutation_scale=7,
                                         color=TEAL, lw=0.9, shrinkA=0, shrinkB=0))
    ax.text(0.45, 1.05, "each camera assigned once, then committed", color=INK,
            fontsize=6.5, va="center")
    ax.text(0.45, 0.55, "targets updated before the next camera", color=TEAL,
            fontsize=6.5, va="center")
    ax.set_xlim(-0.1, 10.1)
    ax.set_ylim(-0.1, 5.1)


def main():
    use()
    fig, axes = grid(1, 2, span="full", row=42.0, despine=False)
    draw_exhaustive(axes[0])
    draw_greedy(axes[1])
    save(fig, 3, "a", "association")


if __name__ == "__main__":
    main()
