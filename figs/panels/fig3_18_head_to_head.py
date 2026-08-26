#!/usr/bin/env python3
"""
Fig 13f -- Fig 3f's time-per-frame head-to-head, redrawn natively at fig13's
2x2-block cell size (2026-08-25 row-2 rebuild; Eric: "the d, e, f is way too
small ... lets make d,e,f more visible"). The old fig13 column scaled Fig 3f's
third-span PDF by 0.667 (5.3 pt type); this is a ~36 x 41 mm native redraw at
7 pt, second cell of the block's first column (under e, the grouping-accuracy
box plot). fig13_sync trues the PDF to the exact cell height.

REUSES FIG 3f's OWN `build()` (imported as a module, not touched -- its
guarded `main()` never runs, so Fig 3's own panel and CSV are untouched):
the floor/ceiling treatment of the unmeasured 4x6 configuration, the
symmetry-reduced hypothesis count, and the never-average `luc3d_for()` match
are all that script's -- see its docstring. The marks follow Fig 3f exactly
(salmon exhaustive, teal LUC3D, open marker + range bar = not measured); the
series labels and the 10^n x callout are re-anchored for the smaller axes,
and the lower-bound arithmetic footnote lives in FIGURE-LEGENDS.md
(`footnote()` is log-only).

    python3 figs/panels/fig13_08_head_to_head.py
"""
import sys
from pathlib import Path

import numpy as np
from matplotlib.ticker import NullLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import SALMON, TEAL, annotate_series, panel, save, use  # noqa: E402
from fig3_sync import CELL_H, CELL_W, place_cell_axes  # noqa: E402
import panels.fig3_06_head_to_head as hh  # noqa: E402


def main():
    use(7.0)
    df, meta = hh.build()

    fig, ax = panel(CELL_W, CELL_H)
    x = np.arange(len(df))
    ok = ~df.extrapolated.values

    ax.plot(x, df.exhaustive_plot_s, color=SALMON, lw=1.8, zorder=3)
    ax.plot(x[ok], df.exhaustive_plot_s[ok], "o", color=SALMON, ms=4.5,
            mec="white", mew=0.9, zorder=4)
    for xi in x[~ok]:
        ax.plot([xi, xi], [df.exhaustive_lo_s[xi], df.exhaustive_hi_s[xi]],
                color=SALMON, lw=1.1, zorder=3)
        ax.plot([xi - 0.07, xi + 0.07],
                [df.exhaustive_hi_s[xi]] * 2, color=SALMON, lw=1.1, zorder=3)
        ax.plot([xi], [df.exhaustive_lo_s[xi]], "o", mfc="white", mec=SALMON,
                mew=1.3, ms=5.5, zorder=5)
    ax.plot(x, df.luc3d_s, color=TEAL, lw=1.8, zorder=3)
    ax.plot(x, df.luc3d_s, "o", color=TEAL, ms=4.5, mec="white", mew=0.9, zorder=4)

    ax.set_yscale("log")
    ax.set_ylim(1e-4, 3e5)
    ax.set_yticks([v for v, _ in hh.TICKS])
    ax.set_yticklabels([lab for _, lab in hh.TICKS])
    ax.yaxis.set_minor_locator(NullLocator())
    ax.set_xlim(-0.35, len(df) - 0.55)
    ax.set_xticks(x)
    ax.set_xticklabels(df.label, fontsize=6.5)
    ax.set_ylabel("time per frame")
    ax.set_xlabel("animals × cameras")

    # Same empty-quadrant placements as Fig 3f, re-anchored for these axes: on
    # this narrower panel the label spans ~1.8 x-units and ~0.8 decades, so
    # both the flat left segment's flanks collided (with the rise toward 3x5
    # above, with the 2x5/2x6 markers below). The UPPER-LEFT quadrant -- where
    # Fig 3f kept its since-deleted composition block -- is genuinely empty
    # here: the curve does not pass 10 s until after the label's last glyph.
    annotate_series(ax, -0.15, 20.0, "exhaustive", SALMON, size=6.5, va="bottom")
    annotate_series(ax, len(df) - 0.6, 0.02, "LUC3D", TEAL, size=6.5, va="bottom",
                    ha="right")
    hi, lo = df.exhaustive_plot_s.iloc[-1], df.luc3d_s.iloc[-1]
    ax.text(len(df) - 0.55, hi ** 0.45 * lo ** 0.55,
            f"10{hh._sup(int(round(np.log10(hi / lo))))}×", color=SALMON,
            fontweight="bold", fontsize=6.5, ha="right", va="center")

    place_cell_axes(fig, ax, "quality_col")   # shared cell x -- fig13_sync.CELL_AXES_X
    save(fig, 3, "f", "head_to_head")


if __name__ == "__main__":
    main()
