#!/usr/bin/env python3
"""
Fig 2g -- Fig 4e's time-per-keypoint bars, RE-ORDERED to match Fig 2f's column
order.

MOVED HERE FROM A DRAFT COMBINED FIG13 (Eric, 2026-08-20: "actually i mean to
add 13 g i and j to fig 2 as the third column in that fig. so remove 13 g i and
j from fig 13 and append it to fig 2"). This is the same panel that was briefly
`fig13_04_time_per_keypoint.py` (13j); that file is deleted. See
`fig2_06_solver_accuracy.py`'s docstring for the rest of the move.

REUSES FIG 4e's OWN `build()` (imported as a module, not touched -- importing
only runs its top-level definitions; `main()` is guarded and never called, so
Fig 4's own panel and CSV are untouched). Fig 4e's own bar order is
DLT/Anipose/refined/Anipose-optim, PAIRED BY ALGORITHM CLASS (its own docstring:
"THE ORDER DELIBERATELY DIFFERS FROM PANEL d" -- reading a pair across is that
panel's whole argument). That argument is Fig 4's alone; this panel is
RE-ORDERED to Anipose-linear/DLT/Anipose-optim/refined to match 2f
(`fig2_07_per_session.py`)'s column order, which it inherited from Fig 4d, so
the two panels read as one consistent column scheme across Fig 2's third row.

COLOUR IS Fig 4e's OWN SALMON/TEAL/GREEN, unchanged -- Anipose linear solid,
Anipose optim hatched, exactly as Fig 4e drew it. (The draft Fig 13 version of
this panel substituted AMBER/SKY for DLT/refined; that substitution existed
only to avoid clashing with Fig 13's exhaustive/greedy content, which does not
exist on Fig 2 -- see `fig2_06_solver_accuracy.py`'s docstring.)

LABELS SHORTENED TO MATCH 2f: Fig 4e's own two-line "Anipose\\noptim" label was
written for the position it holds THERE -- last, with empty page to its right.
Moved to third (this panel's shared order puts DLT second and refined fourth),
its second line ran into "refined"'s label with no gap. 2f already solves this
by dropping the "Anipose"/library prefix once colour already carries it (green
= Anipose in both panels) -- "linear"/"DLT"/"optim"/"refined", one line each.
Same fix, same labels, here.

    python3 figs/panels/fig2_08_time_per_keypoint.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import MUTED, entity, panel, save, use  # noqa: E402
import panels.fig2_16_time_per_keypoint as fig4e  # noqa: E402

#: shared column order with 2f (Anipose-linear, DLT, Anipose-optim, refined),
#: not Fig 4e's own DLT/Anipose/refined/Anipose-optim pairing -- see docstring.
ORDER = ["Anipose", "DLT", "Anipose optim", "refined"]

#: one-line labels matching 2f's SHORT_LABEL -- see docstring.
SHORT_LABEL = {"Anipose": "linear", "DLT": "DLT",
              "Anipose optim": "optim", "refined": "refined"}


def main():
    use()
    df = fig4e.build()
    df = df.set_index("solver").loc[ORDER].reset_index()
    colors = [entity("dlt") if r.solver == "DLT" else
             entity("refined") if r.solver == "refined" else
             entity("anipose") for r in df.itertuples()]

    fig, ax = panel("third", "std")
    # BOTTOM MARGIN MATCHED TO 2f (Eric: "make sure the 2f x axis is at the same
    # level at the 2g x axis"). 2f's rotated 40 deg tick labels need more room
    # below the axis than this panel's horizontal ones, so left to its own
    # constrained_layout this panel's x axis sat ~3.1 mm lower on the page than
    # 2f's. Reserving the same bottom margin here pushes it up to match.
    fig.get_layout_engine().set(rect=(0, 0.061, 1, 1))
    for i, r in df.iterrows():
        ax.bar(i, r.us_per_keypoint, width=0.66, color=colors[i], zorder=2,
              hatch="///" if r.solver == "Anipose optim" else None,
              edgecolor="white" if r.solver == "Anipose optim" else "none",
              linewidth=0)
    top = df.us_per_keypoint.max()
    hi = df.hi.max()
    cap = float(max(top, hi if hi == hi else 0.0))
    for i, r in df.iterrows():
        if r.lo is not None and r.hi is not None and r.hi > r.lo:
            ax.plot([i, i], [r.lo, r.hi], color=MUTED, lw=0.8, zorder=3)
            for y in (r.lo, r.hi):
                ax.plot([i - 0.09, i + 0.09], [y, y], color=MUTED, lw=0.8, zorder=3)
        y = max(r.us_per_keypoint, r.hi if r.hi is not None else 0)
        ax.text(i, y + cap * 0.025, f"{r.us_per_keypoint:.1f}", ha="center",
                va="bottom", fontweight="bold", color=colors[i])

    # THE TWO PAIRWISE RATIOS, re-paired for the new order: (Anipose, DLT) is
    # now indices (0, 1) and (Anipose optim, refined) is (2, 3).
    v = df.us_per_keypoint.values
    for (lo_i, hi_i), yf in (((0, 1), 1.16), ((2, 3), 1.16)):
        y = cap * yf
        ax.annotate("", xy=(hi_i, y), xytext=(lo_i, y),
                    arrowprops=dict(arrowstyle="-", lw=0.7, color=MUTED))
        ax.text((lo_i + hi_i) / 2, y + cap * 0.015,
                f"{v[lo_i] / v[hi_i]:.1f}× ours", ha="center", va="bottom",
                fontsize=6, fontweight="bold", color=MUTED)
    ax.set_ylim(0, cap * 1.36)
    ax.set_xticks(np.arange(len(df)))
    ax.set_xticklabels([SHORT_LABEL[s] for s in df.solver])
    for lab, c in zip(ax.get_xticklabels(), colors):
        lab.set_color(c)
    ax.set_ylabel("µs per keypoint")
    save(fig, 2, "g", "time_per_keypoint")


if __name__ == "__main__":
    main()
