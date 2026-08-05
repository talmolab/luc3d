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
from src.style import MUTED, SPAN, mm, GREY, INK, SALMON, TEAL, deposit, save, use  # noqa: E402
from src.tools_table import CHECK_DATE, COLS, NEEDS_CHECK, TOOLS  # noqa: E402

NO = "–"

#: Cell type is smaller than the 8 pt body so the longest strings ("Maree et al.
#: 2024", "1 animal, pairwise") clear their column. The header stays at 8 pt.
CELL_PT = 6.5
#: The pre-submission note under the table, in points.
NOTE_PT = 7.0

#: Row pitch -- ONE data unit -- in points, baseline to baseline. THIS IS THE PANEL'S
#: HEIGHT: the height below is derived from it, rather than the pitch being derived
#: from a height picked in advance.
#:
#: It was 10.55 pt, as a side effect of declaring the figure `3.9 mm * (nrow + 2)`
#: tall. Against a 6.5 pt cell -- whose font box PyMuPDF measures at 7.27 pt -- that
#: left 3.3 pt of white between consecutive rows, so 38% of the panel's own height was
#: internally blank at 39 mm tall and Fig 1 was 1 mm under the 200 mm ceiling with no
#: room for a caption. 9.0 pt leaves 1.7 pt, i.e. 1.24x the font box, which is normal
#: table leading and still more than the 1.18x that would let a descender in one row
#: meet an ascender in the next.
#:
#: NOTHING IS SMALLER AS A RESULT. Every type size on this panel is unchanged (8 pt
#: header, 6.5 pt cells, 7 pt note) and so is every glyph; only the white between the
#: rows came out. Verify by re-measuring the rendered row ink: it was 29 px per row at
#: 300 dpi before this change and is 29 px after.
ROW_PITCH_PT = 9.0
#: PyMuPDF's span-box height as a multiple of the font size, measured on this panel's
#: own PDF (7.27 pt at 6.5 pt type). Used to keep the note's box inside the axes.
FONT_BOX = 1.12
#: Outer margin, in points. Everything drawn is inside the y limits below, so this is
#: pure trim clearance; constrained_layout's 3 pt default was 1 mm of dead figure at
#: each edge, and the assembler already leaves 4.5 mm of lead for the panel letter.
PAD_PT = 1.2


#: The checkmark's two vertical offsets from the cell baseline, IN POINTS. They used
#: to be 0.18 and 0.30 DATA units, which meant the mark's printed height was set by
#: the row pitch: tightening the pitch would have quietly shrunk every affirmative
#: cell's tick by the same fraction it took off the panel. In points the tick prints
#: at exactly the size it did at the old 10.55 pt pitch (0.18 x 10.55 = 1.9,
#: 0.30 x 10.55 = 3.16) whatever the pitch becomes.
TICK_DOWN_PT, TICK_UP_PT = 1.90, 3.16

#: The three rules and the note, as distances IN POINTS from the row they hang off:
#: above the header, below the header, below the last row, and the note's baseline
#: below the last row. Same argument as the tick -- these were 0.55, 0.45, 0.45 and
#: 1.05 data UNITS, so tightening the row pitch would have pulled the rule under the
#: header up into the descenders of "3D proofreading" (at 9 pt pitch the 0.45-unit
#: rule lands 4.05 pt below the header's centre, inside its 4.48 pt half font box --
#: measured: the header and the rule merged into one ink run). Pinned in points, every
#: distance that is NOT row-to-row prints exactly as it did at the old 10.55 pt pitch,
#: so the only thing this panel's height change moves is the leading between rows.
RULE_ABOVE_HEAD_PT = 5.80       # 0.55 u x 10.55 pt
RULE_BELOW_HEAD_PT = 4.75       # 0.45 u
RULE_BELOW_LAST_PT = 4.75       # 0.45 u
NOTE_BELOW_LAST_PT = 11.08      # 1.05 u
#: Header row to first data row, in points. NOT the row pitch, for the same reason:
#: the header is 8 pt (an 8.96 pt font box) and the rule below it hangs 4.75 pt under
#: its centre, so a 9 pt gap leaves the rule 0.6 pt off the top of "LUC3D (this
#: work)" -- measured, they merged into one ink run. The header therefore keeps the
#: 10.55 pt it always had and only the DATA rows close up.
HEAD_GAP_PT = 10.55


def tick(ax, x, y, color=TEAL, s=0.0075, lw=1.1):
    """A checkmark drawn as two strokes.

    NOT the character U+2713: Liberation Sans (the Arial substitute) has no glyph
    for it and matplotlib silently rendered a tofu box in every affirmative cell.
    Drawing it also keeps the mark on the same stroke weight as the rules.
    """
    down, up = TICK_DOWN_PT / ROW_PITCH_PT, TICK_UP_PT / ROW_PITCH_PT
    ax.plot([x, x + s, x + 2.8 * s], [y, y - down, y + up],
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

    def u(pt):
        """Points -> data units, i.e. a distance that must NOT follow the row pitch."""
        return pt / ROW_PITCH_PT

    #: Data rows are one unit apart -- that unit IS `ROW_PITCH_PT`. The header is not
    #: a data row and sits `HEAD_GAP_PT` above the first one.
    def row_y(i):
        return nrow - i + 0.1

    y_last = row_y(nrow - 1)
    y_head = row_y(0) + u(HEAD_GAP_PT)
    y_rules = ((y_head + u(RULE_ABOVE_HEAD_PT), 0.9),
               (y_head - u(RULE_BELOW_HEAD_PT), 0.6),
               (y_last - u(RULE_BELOW_LAST_PT), 0.9))
    y_note = y_last - u(NOTE_BELOW_LAST_PT)

    # THE Y LIMITS ARE THE INK, and the height follows from them. Top: the header
    # rule, plus half its 0.9 pt stroke. Bottom: the bottom of the pre-submission
    # note's font box when it is drawn, otherwise the last rule -- so CLEARING
    # `NEEDS_CHECK` automatically buys back the 11 pt it occupies instead of leaving a
    # blank strip behind. Nothing is drawn outside this range, which is what lets the
    # outer pad go down to PAD_PT.
    y_top = y_rules[0][0] + u(0.5 * 0.9)
    y_bot = (y_note - u(0.5 * NOTE_PT * FONT_BOX) if NEEDS_CHECK
             else y_rules[2][0] - u(0.5 * 0.9))
    h_mm = ((y_top - y_bot) * ROW_PITCH_PT + 2 * PAD_PT) / 72 * 25.4

    fig, ax = plt.subplots(figsize=(mm(SPAN["full"]), mm(h_mm)),
                           layout="constrained")
    # `w_pad`/`h_pad` are INCHES.
    fig.get_layout_engine().set(w_pad=PAD_PT / 72, h_pad=PAD_PT / 72)
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(y_bot, y_top)

    for j, c in enumerate(COLS):
        ax.text(x0[j], y_head, c, fontweight="bold", va="center", color=INK)

    for i, t in enumerate(TOOLS):
        first = i == 0                      # LUC3D, the only row we may assert
        ax.text(x0[0], row_y(i), t[0], va="center", color=INK,
                fontsize=CELL_PT, fontweight="bold" if first else "normal")
        for j in range(1, ncol):
            v = t[j]
            if v is True:
                tick(ax, x0[j], row_y(i))
            elif v is False:
                ax.text(x0[j], row_y(i), NO, va="center", color=MUTED,
                        fontsize=CELL_PT)
            else:
                ax.text(x0[j], row_y(i), str(v), va="center", color=MUTED,
                        fontsize=CELL_PT,
                        fontweight="bold" if first else "normal")

    for y, lw in y_rules:
        ax.plot([0, 1], [y, y], color=INK, lw=lw, clip_on=False)

    if NEEDS_CHECK:
        # Prints onto the artwork on purpose: third-party cells go stale, and a
        # figure that quietly asserts someone else's feature set is the failure mode.
        ax.text(0, y_note,
                f"third-party cells from published docs, checked {CHECK_DATE} — "
                f"re-verify before submission", color=SALMON, fontsize=NOTE_PT,
                va="center")

    save(fig, 1, "d", "tool_table")


if __name__ == "__main__":
    main()
