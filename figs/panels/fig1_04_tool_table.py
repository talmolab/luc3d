#!/usr/bin/env python3
"""
Fig 1d -- where LUC3D sits among existing multi-camera pose tools.

The cells and every claim behind them live in `src/tools_table.py`; read its
docstring before changing anything here. This module only draws.

Drawn as a rules-only table in the house type: a hairline above the header, one
below it and one under the last row, no verticals, no fill, no zebra striping. The
old `nature.py` version boxed every cell, which put more ink into the grid than into
the content.

    python3 figs/panels/fig1_04_tool_table.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import SPAN, mm, GREY, INK, SALMON, TEAL, deposit, save, use  # noqa: E402
from src.tools_table import CHECK_DATE, COLS, NEEDS_CHECK, TOOLS  # noqa: E402

NO = "–"

#: Cell type is smaller than the 8 pt body so the longest strings ("Maree et al.
#: 2024", "1 animal, pairwise") clear their column. The header stays at 8 pt.
CELL_PT = 6.5


def tick(ax, x, y, color=TEAL, s=0.0075, lw=1.1):
    """A checkmark drawn as two strokes.

    NOT the character U+2713: Liberation Sans (the Arial substitute) has no glyph
    for it and matplotlib silently rendered a tofu box in every affirmative cell.
    Drawing it also keeps the mark on the same stroke weight as the rules.
    """
    ax.plot([x, x + s, x + 2.8 * s], [y, y - 0.18, y + 0.30],
            color=color, lw=lw, solid_capstyle="round",
            solid_joinstyle="miter", clip_on=False)


def main():
    use()
    deposit(pd.DataFrame(TOOLS, columns=COLS), 1, "fig1d_tool_table.csv")

    nrow, ncol = len(TOOLS), len(COLS)
    # Column widths in axes units, sized to the longest string each column carries
    # plus a gutter. Every column previously overflowed into its neighbour.
    widths = [0.205, 0.105, 0.135, 0.125, 0.165, 0.150, 0.115]
    x0 = [sum(widths[:i]) for i in range(ncol)]

    fig, ax = plt.subplots(figsize=(mm(SPAN["full"]), mm(4.4 * (nrow + 2))),
                           layout="constrained")
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, nrow + 1.6)

    def row_y(i):
        return nrow - i + 0.1

    for j, c in enumerate(COLS):
        ax.text(x0[j], row_y(-1), c, fontweight="bold", va="center", color=INK)

    for i, t in enumerate(TOOLS):
        first = i == 0                      # LUC3D, the only row we may assert
        ax.text(x0[0], row_y(i), t[0], va="center", color=INK,
                fontsize=CELL_PT, fontweight="bold" if first else "normal")
        for j in range(1, ncol):
            v = t[j]
            if v is True:
                tick(ax, x0[j], row_y(i))
            elif v is False:
                ax.text(x0[j], row_y(i), NO, va="center", color=GREY,
                        fontsize=CELL_PT)
            else:
                ax.text(x0[j], row_y(i), str(v), va="center", color=GREY,
                        fontsize=CELL_PT,
                        fontweight="bold" if first else "normal")

    for y, lw in ((row_y(-1) + 0.55, 0.9), (row_y(-1) - 0.45, 0.6),
                  (row_y(nrow - 1) - 0.45, 0.9)):
        ax.plot([0, 1], [y, y], color=INK, lw=lw, clip_on=False)

    if NEEDS_CHECK:
        # Prints onto the artwork on purpose: third-party cells go stale, and a
        # figure that quietly asserts someone else's feature set is the failure mode.
        ax.text(0, row_y(nrow - 1) - 1.05,
                f"third-party cells from published docs, checked {CHECK_DATE} — "
                f"re-verify before submission", color=SALMON, fontsize=7,
                va="center")

    save(fig, 1, "d", "tool_table")


if __name__ == "__main__":
    main()
