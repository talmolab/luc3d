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

THE HEIGHT IS DERIVED, NOT DECLARED, AND THE DRAWING SCALE IS PINNED. This panel used
to ask for `row=42.0` and lay its content out in a 5.0-unit-tall box, which left
5.1 mm of white between the sub-heading and the hypothesis grid, 3.1 mm under the last
note line, 0.77 mm of axes margin at each end and matplotlib's default 1.06 mm of
constrained-layout pad -- 6.7 mm of a 42 mm panel carrying nothing, on a figure that
was 19.6% blank rows.

Shrinking `row=` on its own is NOT the fix: `blank()` sets `aspect("equal")`, and
although this panel overrides that to `"auto"` (the two boxes are diagrams, not
geometry, so they may stretch), the axes still fills whatever height is declared --
so a smaller `row=` would have SHRUNK the grid cells, the camera glyphs and the gaps
between them by the same factor. Instead `MM_PER_UNIT` is measured off the 42 mm
version and pinned, the dead gaps are taken out in data units, and `ROW_MM` is
computed from what is left. The drawing therefore prints at exactly the size it did
before -- the ink bounding box is unchanged in WIDTH to the pixel and shorter in
height by precisely the white that was removed -- and every type size is untouched.

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

#: Grid cell size and gaps, in data units. The CONTENT BAND both sides share is
#: NROW cells plus the gaps between them, and every element on the greedy side is
#: placed relative to that band's floor, so the two halves stay registered.
CW, CH, CGX, CGY = 0.95, 0.42, 0.20, 0.22
BAND_H = NROW * CH + (NROW - 1) * CGY          # 1.70

#: THE VERTICAL LAYOUT, in data units, and the pinned scale that turns it into
#: millimetres. `MM_PER_UNIT` was measured off the 42 mm version of this panel
#: (axes 39.88 mm over a 5.2-unit ylim) and must NOT be recomputed from the new
#: height -- pinning it is what keeps the drawing at its old print size while the
#: dead space comes out. The gaps below are what changed:
#:
#:     sub-heading -> content band   5.1 mm -> 2.2 mm
#:     content band -> first note    2.7 mm -> 2.0 mm
#:     last note -> box floor        3.1 mm -> 1.6 mm
#:     axes margin, each end        0.77 mm -> 0.23 mm   (YPAD)
#:     constrained-layout pad       1.06 mm -> 0.80 mm   (HPAD_MM; 0.80 keeps the
#:                                                        box border ~1.5 mm clear
#:                                                        of the assembled letter)
MM_PER_UNIT = 39.88 / 5.2
H_BOX = 4.34                                   # box height, was 5.0
Y_TITLE = H_BOX - 0.38
Y_SUB = H_BOX - 0.90
Y_BAND = H_BOX - 1.367 - BAND_H                # floor of the content band
Y_NOTE1 = Y_BAND - 0.411
Y_NOTE2 = Y_NOTE1 - 0.50
YPAD = 0.03                                    # axes margin outside the box
HPAD_MM = 0.80
ROW_MM = MM_PER_UNIT * (H_BOX + 2 * YPAD) + 2 * HPAD_MM


def box(ax, title, sub, accent):
    """The panel's frame, accent bar and two-line heading."""
    ax.add_patch(Rectangle((0, 0), 10, H_BOX, fill=False, ec="#DDDDDD", lw=0.8))
    ax.add_patch(Rectangle((0, 0), 0.16, H_BOX, facecolor=accent, edgecolor="none"))
    ax.text(0.45, Y_TITLE, title, fontweight="bold", color=INK, fontsize=7.5,
            va="center")
    # 8.0, not 6.5: mathtext superscripts render at ~0.7x, so (A!)$^C$ at
    # 6.5 pt put its C at 4.55 pt -- under Nature's 5 pt floor.
    ax.text(0.45, Y_SUB, sub, color=MUTED, fontsize=8.0, va="center")


def draw_exhaustive(ax):
    blank(ax)
    ax.set_aspect("auto")
    box(ax, "Exhaustive hypothesis testing", "Maree et al. 2024 · (A!)$^C$ per frame",
        SALMON)
    w, h, gx, gy = CW, CH, CGX, CGY
    x0, y0 = 0.55, Y_BAND
    for r in range(NROW):
        for c in range(NCOL):
            win = (c, r) == WIN
            ax.add_patch(Rectangle(
                (x0 + c * (w + gx), y0 + r * (h + gy)), w, h,
                facecolor=SALMON if win else "#EEEEEE", edgecolor="none"))
    ax.text(0.45, Y_NOTE1, "every grouping triangulated + scored", color=INK,
            fontsize=6.5, va="center")
    ax.text(0.45, Y_NOTE2, "one kept: lowest reprojection error", color=SALMON,
            fontsize=6.5, va="center")
    ax.set_xlim(-0.1, 10.1)
    ax.set_ylim(-YPAD, H_BOX + YPAD)


def draw_greedy(ax):
    blank(ax)
    ax.set_aspect("auto")
    box(ax, "Greedy per-view assignment", "LUC3D · C Hungarian solves, O(C·A³)", TEAL)
    # Offsets from the content band's floor, so this side keeps its old registration
    # with the hypothesis grid opposite it (camera row +1.20, H row +0.20).
    y_cam, y_h = Y_BAND + 1.20, Y_BAND + 0.20
    for i in range(NCAM):
        x = 0.7 + i * 2.35
        icon(ax, "camera", x, y_cam, s=0.62, color=INK)
        ax.add_patch(Rectangle((x, y_h), 0.72, 0.62, fill=False, ec=TEAL, lw=0.9))
        ax.text(x + 0.36, y_h + 0.31, "H", ha="center", va="center", color=TEAL,
                fontsize=7, fontweight="bold")
        if i < NCAM - 1:
            ax.add_patch(FancyArrowPatch((x + 0.86, y_h + 0.31),
                                         (x + 2.2, y_h + 0.31),
                                         arrowstyle="-|>", mutation_scale=7,
                                         color=TEAL, lw=0.9, shrinkA=0, shrinkB=0))
    ax.text(0.45, Y_NOTE1, "each camera assigned once, then committed", color=INK,
            fontsize=6.5, va="center")
    ax.text(0.45, Y_NOTE2, "targets updated before the next camera", color=TEAL,
            fontsize=6.5, va="center")
    ax.set_xlim(-0.1, 10.1)
    ax.set_ylim(-YPAD, H_BOX + YPAD)


def main():
    use()
    fig, axes = grid(1, 2, span="full", row=ROW_MM, despine=False)
    # Vertical pad only. `w_pad` is left at matplotlib's default, so the horizontal
    # geometry -- and therefore the ink bounding box's WIDTH -- is untouched.
    fig.get_layout_engine().set(h_pad=HPAD_MM / 25.4)
    draw_exhaustive(axes[0])
    draw_greedy(axes[1])
    save(fig, 3, "a", "association")


if __name__ == "__main__":
    main()
