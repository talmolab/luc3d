#!/usr/bin/env python3
"""
Fig 3d -- 3D-term ablation: ID switches and cross-view IDF1 against r = corr3d/corr2d.

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

r = 0 is the "no 3D term at all" control the handoff asked for, and it is the point
of the panel: without the 3D term the tracker makes 1,329 switches.

THE METRIC IS IDF1, NOT HOTA. Nothing in luc3d-bench computes HOTA. Do not relabel.

Source: figs/out/fig3_sweep.json `cells`.

    python3 figs/panels/fig3_04_sweep.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, SALMON, TEAL, deposit, footnote, panel,  # noqa: E402
                       save, text_legend, use)

METRIC = "idf1_cross"

#: The app's shipped ratio (corr2d 1.0, corr3d 6.0 -> r = 6).
SHIPPED_R = 6.0


def build() -> pd.DataFrame:
    cells = [c for c in load("fig3_sweep.json")["cells"] if c.get(METRIC) is not None]
    df = pd.DataFrame(cells)
    df["r"] = df.corr3d / df.corr2d

    # VERIFY the collapse rather than asserting it. If a future sweep breaks the
    # ratio-only property this panel would silently average two different regimes.
    for r, g in df.groupby("r"):
        if g[METRIC].nunique() > 1 or g["switches"].nunique() > 1:
            sys.exit(
                f"fig3d: cells with r={r:g} disagree "
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
    deposit(df, 3, "fig3d_sweep.csv")

    # A THIRD, NOT A HALF. This panel shares its row with b and c, and the grid only
    # closes at 180 mm if all three are "third": at "half" the row summed to 210.6 mm
    # and `assemble.py` centres a row, so panel b was placed at x = -15.3 mm and its
    # y axis was cut off the page. Nothing in a per-panel render shows that.
    fig, ax = panel("third", "std", key=2)
    x = np.arange(len(df))                      # even spacing: r is not linear

    # ID switches, log, on the left.
    ax.plot(x, df.switches.clip(lower=1), color=SALMON, lw=2.0, zorder=3)
    ax.plot(x, df.switches.clip(lower=1), "o", color=SALMON, ms=4, mec="white",
            mew=0.8, zorder=4)
    ax.set_yscale("log")
    ax.set_ylabel("ID switches", color=SALMON)
    ax.tick_params(axis="y", colors=SALMON)
    ax.spines["left"].set_color(SALMON)
    # 12 ratios in one row overlapped at the low end, where they bunch (0, 0.25,
    # 0.5, 1). Label every tick but drop the ones that collide. The dropped set grew
    # when the panel came down to a "third": 12 ticks over ~76 pt is 6.9 pt of pitch,
    # measured, so an 11.5 pt "0.5" literally overlapped its neighbouring "1", and
    # even the digits that technically cleared each other closed to a 2.4 pt gap and
    # read as one run ("4 6 8"). What survives is exactly the set the docstring argues
    # from -- 0 (the control), 1 and 2 (the two knees), 6 (shipped) and 24 (the end of
    # the sweep) -- which also happens to be sparse enough to be legible. 1 and 2 are
    # adjacent ticks and cannot be separated further; both are kept because the whole
    # point of the panel is that IDF1 stops improving at one of them and switches at
    # the other.
    ax.set_xticks(x)
    ax.set_xticklabels([f"{v:g}" if v in (0, 1.0, 2.0, 6.0, 24.0) else ""
                        for v in df.r])
    ax.set_xlabel("r = corr3d / corr2d")
    # "(no 3D term)" used to be the second line of the r = 0 tick label. Centred on
    # the leftmost tick it is ~50 pt wide and ran off the left edge of the narrower
    # panel, so the gloss moves under the axis where its width is the panel's.
    footnote(ax, "r = 0: no 3D term at all")

    # Cross-view IDF1 on the right.
    ax2 = ax.twinx()
    ax2.spines["top"].set_visible(False)
    ax2.plot(x, df.idf1, color=TEAL, lw=2.0, zorder=3)
    ax2.plot(x, df.idf1, "o", color=TEAL, ms=4, mec="white", mew=0.8, zorder=4)
    ax2.set_ylabel("cross-view IDF1", color=TEAL)
    ax2.tick_params(axis="y", colors=TEAL)
    ax2.spines["right"].set_color(TEAL)

    # The shipped ratio, on the r axis.
    xr = float(np.interp(SHIPPED_R, df.r, x))
    ax.axvline(xr, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    ax.annotate(f"shipped r = {SHIPPED_R:g}", (xr, 1.0),
                xycoords=("data", "axes fraction"), xytext=(0, 2),
                textcoords="offset points", color=GREY, fontsize=6.5,
                ha="center", va="bottom")

    text_legend(ax, [("ID switches", SALMON), ("cross-view IDF1", TEAL)], "above")
    save(fig, 3, "d", "sweep")


if __name__ == "__main__":
    main()
