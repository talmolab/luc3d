#!/usr/bin/env python3
"""
Fig 3e -- 3D-term ablation: ID switches and cross-view IDF1 against r = corr3d/corr2d.

THE SWEEP IS ONE-DIMENSIONAL AND THIS PANEL SAYS SO. The cost function sums a 2D and
a 3D term, and only their RATIO matters -- all 24 (corr2d, corr3d) cells collapse
exactly onto r = corr3d/corr2d. This is verified here, not assumed: `build()` asserts
that every cell sharing an r reports identical IDF1 and identical switches, and it
does (r = 1 gives 0.9518 / 14 switches whether it came from 0.5/0.5 or 1/1).

An earlier version of this panel drew the raw 24-cell (corr2d, corr3d) heat map and
was unreadable for exactly that reason: 18 of 21 cells tied, because they were the
same r. Collapsing onto r turns a flat grid into a curve with a clear knee.

TWO AXES BECAUSE THE TWO METRICS SATURATE AT DIFFERENT POINTS, and that is the
finding: cross-view IDF1 is flat from r = 1, but ID switches keep falling and only
bottom out at r = 2, dropping from 1,329 with no 3D term at all to 2. IDF1 alone
would say "anything >= 1 is fine"; switches say where it actually stops improving.
The shipped r = 6 sits comfortably past both knees.

r IS ON A REAL LOG AXIS, NOT A CATEGORY INDEX. It used to be plotted at
`np.arange(len(df))` -- the 12 sampled ratios 0, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12,
16, 24 at EQUAL spacing -- and that made both of the claims above partly artefacts
of the sampling: on an index, the distance from r = 1 to r = 2 is the same as from
r = 16 to r = 24, so "the knee is at 2" and "the shipped 6 sits past both knees"
were being read off a geometry that has nothing to do with r. Worse, 12 ticks over
~30 mm of plot is 2.5 mm of pitch, so 7 of the 12 tick labels had to be suppressed
to stop them colliding and the reader could not place a knee at all.

Of the three fixes available, a genuine log axis is the only one that fixes the
GEOMETRY: rotating all 12 labels to 90 deg would make them legible but leaves the
spacing false, and printing "x is an index, spacing is not proportional" is honest
but still unreadable. The cost of the log axis is that a subset of ticks is still
labelled -- 0, 1, 2, 6, 24, which is what fits at 8 pt in 30 mm -- but that is
now harmless, because positions are proportional and interpolating between labelled
decades is exactly what a log axis is for. Every sampled r is still visible: each is
drawn with its own marker.

r = 0 IS OFF A LOG AXIS, SO IT GETS A BREAK. r = 0 is the "no 3D term at all"
control the handoff asked for and the point of the panel (1,329 switches without
it), so it cannot be dropped just because log(0) is undefined. It is drawn in a
slot to the left of the log region, its tick labelled `0`, with an explicit break
mark on the x spine and a DOTTED connector across the break -- so the one position
on the axis that is not to scale announces itself, and the other eleven are.
`BREAK_DEC` is the size of that slot in decades; nothing else on the panel depends
on it.

THE METRIC IS IDF1, NOT HOTA. Nothing in luc3d-bench computes HOTA. Do not relabel.

Source: figs/out/fig3_sweep.json `cells`.

    python3 figs/panels/fig3_05_sweep.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.ticker import NullLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, GREY, SALMON, TEAL, deposit, footnote, panel,  # noqa: E402
                       save, text_legend, use)

METRIC = "idf1_cross"

#: The app's shipped ratio (corr2d 1.0, corr3d 6.0 -> r = 6).
SHIPPED_R = 6.0

#: Width of the r = 0 slot, in DECADES to the left of the smallest positive r. Wide
#: enough that its `0` tick label clears the next labelled tick, narrow enough that
#: the break reads as a break rather than as a second panel.
BREAK_DEC = 0.20

#: Which r values get a tick LABEL. Every r is drawn (each has a marker); these are
#: the ones whose labels fit at 8 pt in a ~30 mm plot without colliding, and they are
#: exactly the set the panel's argument is made from: 0 the control, 1 and 2 the two
#: knees, 6 the shipped ratio, 24 the end of the sweep. MEASURED, not guessed -- an
#: earlier version also labelled 0.5, whose glyphs ended 0.80 mm (2.3 pt) from the
#: "1" beside it, i.e. one space width: PyMuPDF read the two as a single "0.5 1" span
#: and so would a reader. The remaining gaps are 3.2 / 2.0 / 4.1 / 4.7 mm.
LABELLED_R = (0.0, 1.0, 2.0, 6.0, 24.0)


def build() -> pd.DataFrame:
    cells = [c for c in load("fig3_sweep.json")["cells"] if c.get(METRIC) is not None]
    df = pd.DataFrame(cells)
    df["r"] = df.corr3d / df.corr2d

    # VERIFY the collapse rather than asserting it. If a future sweep breaks the
    # ratio-only property this panel would silently average two different regimes.
    for r, g in df.groupby("r"):
        if g[METRIC].nunique() > 1 or g["switches"].nunique() > 1:
            sys.exit(
                f"fig3e: cells with r={r:g} disagree "
                f"({sorted(g[METRIC].unique())}, switches {sorted(g.switches.unique())})"
                " — the sweep is no longer one-dimensional in corr3d/corr2d, so this "
                "panel's collapse is invalid. Plot the full grid instead.")

    out = (df.groupby("r")
             .agg(idf1=(METRIC, "first"), switches=("switches", "first"),
                  n_cells=("switches", "size"), n_sessions=("n_sessions", "first"))
             .reset_index().sort_values("r"))
    return out


def main():
    use()
    df = build()
    deposit(df, 3, "fig3e_sweep.csv")

    # A THIRD, NOT A HALF. This panel shares its row with d and f, and the grid only
    # closes at 180 mm if all three are "third": at "half" that row summed to 210.6 mm
    # and `assemble.py` used to CENTRE an over-wide row, so its first panel was placed
    # at x = -15.3 mm and had its y axis cut off the page. Nothing in a per-panel
    # render shows that; `assemble.py` now refuses the row instead.
    fig, ax = panel("third", "std", key=2)

    # r ON A LOG AXIS, with the r = 0 control in a broken-off slot to its left. See
    # the docstring: at even spacing this axis made "the knee is at r = 2" a
    # statement about the sampling grid rather than about r.
    r = df.r.to_numpy(dtype=float)
    first = float(r[r > 0].min())                 # 0.25, the smallest sampled ratio
    zero_x = first * 10 ** -BREAK_DEC             # where the r = 0 datum is drawn
    x = np.where(r > 0, r, zero_x)
    pos = r > 0
    # Row 0 is r = 0 only because build() sorts ascending and the control is in the
    # sweep. Checked rather than assumed: if the control ever drops out of the JSON,
    # `x[:2]` would silently draw a "break" connector between two real ratios.
    has_zero = bool(r[0] == 0.0) and bool(pos[1:].all())

    def series(axis, y, color, ms):
        """One series: solid over the log region, DOTTED across the break."""
        axis.plot(x[pos], y[pos], color=color, lw=2.0, zorder=3)
        if has_zero:
            axis.plot(x[:2], y[:2], color=color, lw=1.2, ls=(0, (1.4, 1.2)),
                      zorder=3)
        axis.plot(x, y, "o", color=color, ms=ms, mec="white", mew=0.8, zorder=4)

    # ID switches, log, on the left.
    series(ax, df.switches.clip(lower=1).to_numpy(dtype=float), SALMON, 4)
    ax.set_yscale("log")
    ax.set_ylabel("ID switches", color=SALMON)
    ax.tick_params(axis="y", colors=SALMON)
    ax.spines["left"].set_color(SALMON)

    ax.set_xscale("log")
    # Limits in decades either side, so the r = 0 slot and the 24 label both clear
    # the spines. Minor ticks off: on a log axis they are a grey haze at this size,
    # and every sampled r already carries a marker.
    ax.set_xlim((zero_x if has_zero else first) * 10 ** -0.22, 24 * 10 ** 0.11)
    ticks = [v for v in LABELLED_R if v > 0 or has_zero]
    ax.set_xticks([zero_x if v == 0 else v for v in ticks])
    ax.set_xticklabels([f"{v:g}" for v in ticks])
    ax.xaxis.set_minor_locator(NullLocator())
    ax.set_xlabel("r = corr3d / corr2d (log)")
    # THE BREAK, ON THE SPINE. Two slashes with the spine whited out between them, so
    # the one position on this axis that is not to scale says so. Drawn in the x-axis
    # transform (x in data, y in axes fractions) and unclipped, so it sits ON the
    # spine rather than inside the data area.
    if has_zero:
        tr = ax.get_xaxis_transform()
        mid = (zero_x * first) ** 0.5
        ax.plot([mid * 10 ** -0.055, mid * 10 ** 0.055], [0, 0], color="white",
                lw=1.6, transform=tr, clip_on=False, zorder=5,
                solid_capstyle="butt")
        for off in (-0.030, 0.030):
            ax.plot([mid * 10 ** (off - 0.022), mid * 10 ** (off + 0.022)],
                    [-0.030, 0.030], color=MUTED, lw=0.8, transform=tr,
                    clip_on=False, zorder=6)
    # "(no 3D term)" used to be the second line of the r = 0 tick label. Centred on
    # the leftmost tick it is ~50 pt wide and ran off the left edge of the narrower
    # panel, so the gloss moves under the axis where its width is the panel's.
    # Legacy printed "LUC3D only · both series are this tracker" on this panel and
    # the restyle dropped it. In a figure whose panel f runs LUC3D against an
    # exhaustive baseline, an unlabelled two-series ablation reads as a
    # between-method comparison, which this one is not.
    footnote(ax, "r = 0: no 3D term, left of the break\n"
                 "both series are LUC3D against itself")

    # Cross-view IDF1 on the right.
    ax2 = ax.twinx()
    ax2.spines["top"].set_visible(False)
    series(ax2, df.idf1.to_numpy(dtype=float), TEAL, 4)
    ax2.set_ylabel("cross-view IDF1", color=TEAL)
    ax2.tick_params(axis="y", colors=TEAL)
    ax2.spines["right"].set_color(TEAL)

    # The shipped ratio, at its own place on the r axis now that the axis has one.
    xr = SHIPPED_R
    ax.axvline(xr, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    ax.annotate(f"shipped r = {SHIPPED_R:g}", (xr, 1.0),
                xycoords=("data", "axes fraction"), xytext=(0, 2),
                textcoords="offset points", color=MUTED, fontsize=6.5,
                ha="center", va="bottom")

    text_legend(ax, [("ID switches", SALMON), ("cross-view IDF1", TEAL)], "above")
    save(fig, 3, "e", "sweep")


if __name__ == "__main__":
    main()
