#!/usr/bin/env python3
"""
Fig 5b -- the proofreading loop LUC3D supports today.

DELIBERATELY DRAWN WITHOUT A RANKING STEP, because there is none. LUC3D reports the
reprojection error for the frame you are on; it does not maintain a ranked worklist,
a sort, or a filter. Panels c and d measure a ranking computed OFFLINE from the same
signal -- they show what such a worklist would be worth, not what the app does.
Drawing a "rank" box here would claim a feature that does not exist.

The bracket marks the three stages that happen ONE FRAME AT A TIME, which is exactly
the limitation c and d quantify: without a worklist the reviewer supplies the
ordering, and the ordering is where the benefit is.

    python3 figs/panels/fig5_01_loop.py
"""
import sys
from pathlib import Path

from matplotlib.patches import FancyArrowPatch, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.diagram import blank, icon  # noqa: E402
from src.style import GREY, INK, SPAN, TEAL, grid, mm, save, use  # noqa: E402

#: label, sub, in-the-loop, icon
STAGES = [
    ("triangulate\nall", "every frame, every group", False, "triangulate"),
    ("read the\nerror", "per node, per view", True, "ids"),
    ("fix", "accept, nudge, drop", True, "check"),
    ("re-triangulate", "the frame you fixed", True, "cube"),
    ("export", ".slp 2.8 / H5", False, "file"),
]
W, H, GAP, NOTCH = 2.05, 1.55, 0.36, 0.26

#: THE PANEL'S HEIGHT IS DERIVED, NOT CHOSEN, because `blank()` sets an EQUAL aspect.
#: The row is 180 mm wide and the diagram is only ~124 mm of that, so the axes is
#: height-limited: the drawing's scale is `(row - PAD) / (Y_TOP - Y_BOT)` mm per data
#: unit and the row height alone decides how big a chevron is. The panel used to be
#: 36 mm tall with `ylim` (-2.325, 1.075) -- 9.97 mm per unit, 2.75 mm of dead paper
#: above the chevrons and 6.2 mm below the bracket label, i.e. 40% of the panel blank
#: with nothing drawn in it. Trimming the y range to the ink (plus a 0.9 mm margin)
#: and recomputing the row at the SAME mm-per-unit takes 7.2 mm off this panel (Fig 5
#: assembles at 179 mm rather than 186) while leaving every chevron and every glyph
#: exactly the size it was -- verified by the ink bbox of the rendered PNG, which is
#: 588 x 2814 px before and after at 600 dpi. Do NOT set
#: `row` by hand here: a row that does not match the y range rescales the artwork.
MM_PER_UNIT = 9.966       # measured on the 36 mm version
PAD_MM = 2.12             # constrained_layout's top+bottom pad, absolute, not scaled
Y_TOP = H / 2 + 0.11      # 0.11 = 0.9 mm above the chevrons' outer stroke
Y_BOT = -1.79             # 0.9 mm below the "one frame at a time" label
ROW_MM = (Y_TOP - Y_BOT) * MM_PER_UNIT + PAD_MM   # 28.8 mm


def main():
    use()
    fig, ax = grid(1, 1, span="full", row=ROW_MM, despine=False)
    blank(ax)

    for i, (label, sub, inloop, kind) in enumerate(STAGES):
        x = i * (W + GAP)
        color = TEAL if inloop else GREY
        ax.add_patch(Polygon(
            [(x, -H / 2), (x + W - NOTCH, -H / 2), (x + W, 0),
             (x + W - NOTCH, H / 2), (x, H / 2), (x + NOTCH, 0)],
            closed=True, facecolor="none", edgecolor=color, lw=1.1,
            joinstyle="miter"))
        icon(ax, kind, x + W / 2 - 0.24, 0.16, s=0.48, color=color)
        ax.text(x + W / 2, -0.14, label, ha="center", va="top", color=INK,
                fontsize=7.5, linespacing=1.2)
        ax.text(x + W / 2, -H / 2 - 0.26, sub, ha="center", va="top", color=GREY,
                fontsize=6.5)
        if i:
            ax.add_patch(FancyArrowPatch(
                (x - GAP + 0.06, 0), (x + 0.04, 0), arrowstyle="-|>",
                mutation_scale=7, color=GREY, lw=0.9, shrinkA=0, shrinkB=0))

    loop_idx = [i for i, s in enumerate(STAGES) if s[2]]
    x0 = loop_idx[0] * (W + GAP)
    x1 = loop_idx[-1] * (W + GAP) + W
    yb = -H / 2 - 0.62
    ax.plot([x0, x0, x1, x1], [yb + 0.16, yb, yb, yb + 0.16], color=TEAL, lw=0.9)
    ax.text((x0 + x1) / 2, yb - 0.12, "one frame at a time", ha="center", va="top",
            color=TEAL, fontsize=7, fontweight="bold")

    ax.set_xlim(-0.35, len(STAGES) * (W + GAP) - GAP + 0.35)
    ax.set_ylim(Y_BOT, Y_TOP)
    save(fig, 5, "b", "loop")


if __name__ == "__main__":
    main()
