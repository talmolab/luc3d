#!/usr/bin/env python3
"""
Fig 2f -- Fig 4d's per-session triangulation box plot, REDRAWN at third span
instead of copied and squeezed into it.

MOVED HERE FROM A DRAFT COMBINED FIG13 (Eric, 2026-08-20: "actually i mean to
add 13 g i and j to fig 2 as the third column in that fig. so remove 13 g i and
j from fig 13 and append it to fig 2"). This is the same panel that was briefly
`fig13_01_per_session_small.py` (13i); that file is deleted. See
`fig2_06_solver_accuracy.py`'s docstring for the rest of the move.

THIS PANEL RE-RUNS FIG 4D'S OWN DRAWING CODE AT A DIFFERENT SIZE, not a copy.
It imports `panels/fig4_05_per_session.py` as a plain module (not touching
Fig 4 -- importing only runs its top-level definitions; `main()` is guarded and
never called, so Fig 4's own panel and CSV are untouched) and reuses its
`build()`, `SOLVERS`, `GROUPS`, `OFFSET`, `GROUP_DX` -- the data and column
layout are identical to 4d -- but calls `panel("third", "std")` instead of
`panel("two-thirds", "std")`, so constrained_layout genuinely reflows the ticks,
labels and box widths into the smaller box instead of a copy being deformed
into it (deforming a copy -- the very first attempt at getting this content
onto a third-span slot at all -- visibly narrowed every glyph on it; see the
now-deleted 13i script's own docstring for the full account).

FOUR COLUMNS OF SHORT, ONE-LINE LABELS, not Fig 4d's own two-line
"Anipose\\nlinear" form -- at third span the two-line labels physically
overlapped. The fix is shorter text, not smaller type. Colour still carries
"which library" (Anipose's two columns share one hue, ours share another, per
Fig 4d's own convention), so the one-line form only needs to say which
CONFIGURATION within that colour -- "linear"/"optim", "DLT"/"refined". Even
shortened, "optim"/"refined" still touch at 0 deg (the column pitch is ~8 mm,
the text ~10-14 mm), so the tick labels are rotated 40 deg.

COLOUR IS Fig 4d's OWN SALMON/TEAL/GREEN here, NOT the AMBER/SKY substitute the
draft Fig 13 version needed -- that substitution existed only to avoid clashing
with Fig 13's exhaustive/greedy content, which does not exist on Fig 2. TEAL
already means "this work" throughout Fig 2 (see `fig2_06_solver_accuracy.py`'s
docstring for the house ENTITY rule this follows).

    python3 figs/panels/fig2_07_per_session.py
"""
import sys
from pathlib import Path

import numpy as np
from matplotlib.colors import to_rgba

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import panel, save, use  # noqa: E402
import panels.fig4_05_per_session as fig4d  # noqa: E402

#: short, ONE-LINE form of fig4d.SOLVERS' two-line tick labels -- see the
#: docstring. Same key/colour, just less text under it.
SHORT_LABEL = {"anipose": "linear", "dlt": "DLT",
               "anipose_optim": "optim", "refined": "refined"}


def main():
    use()
    df = fig4d.build()

    fig, ax = panel("third", "std")
    centres, cols = {}, []
    for gi, (key, label, note) in enumerate(fig4d.GROUPS):
        g = df[df.group == key]
        xs = {k: gi * fig4d.GROUP_DX + fig4d.OFFSET[k] for k, *_ in fig4d.SOLVERS}
        cols += [(xs[k], SHORT_LABEL[k], c) for k, _, c in fig4d.SOLVERS]
        centres[key] = (gi * fig4d.GROUP_DX, label, note, g)
        for k, _, color in fig4d.SOLVERS:
            open_box = k.endswith("_optim")
            ax.boxplot([g[k].to_numpy()], positions=[xs[k]], widths=0.34,
                      patch_artist=True, manage_ticks=False, zorder=2, whis=1.5,
                      medianprops=dict(color=color if open_box else "white", lw=1.6),
                      boxprops=dict(facecolor="none" if open_box
                                    else to_rgba(color, 0.85),
                                    edgecolor=color, lw=0.9),
                      whiskerprops=dict(color=color, lw=0.9),
                      capprops=dict(color=color, lw=0.9),
                      flierprops=dict(marker="o", ms=3.0, markerfacecolor=color,
                                      markeredgecolor=color, alpha=0.6))

    keys = [k for k, *_ in fig4d.SOLVERS]
    drawn = df[df.group == fig4d.GROUPS[0][0]]
    lo, hi = drawn[keys].min().min(), drawn[keys].max().max()
    ax.set_ylim(lo - 0.12, hi + 0.38)
    ax.set_xlim(min(fig4d.OFFSET.values()) - 0.45, max(fig4d.OFFSET.values()) + 0.45)
    ax.set_ylabel("reprojection error, median (px)\nin the cameras the solve used")

    ticks, labels = [], []
    for centre, label, note, g in centres.values():
        for k, _, color in fig4d.SOLVERS:
            ax.text(centre + fig4d.OFFSET[k], hi + 0.30, f"{np.median(g[k]):.2f}",
                    ha="center", va="top", fontweight="bold", fontsize=8, color=color)
        ticks.append(centre)
        labels.append("")

    ax.xaxis.remove_overlapping_locs = False
    ax.set_xticks([x for x, *_ in cols], minor=True)
    ax.set_xticklabels([t for _, t, _ in cols], minor=True, fontsize=8,
                       rotation=40, ha="right", rotation_mode="anchor")
    for lab, (_, _, color) in zip(ax.get_xticklabels(minor=True), cols):
        lab.set_color(color)
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels)
    ax.tick_params(axis="x", which="minor", length=0, pad=1.0)
    ax.tick_params(axis="x", which="major", length=0, pad=2.0)
    save(fig, 2, "f", "per_session")


if __name__ == "__main__":
    main()
