#!/usr/bin/env python3
"""
Fig 7g -- the measured LUC3D DISADVANTAGE: it fragments more tracks than SLEAP.

THIS PANEL EXISTS BECAUSE THE DEPOSIT SAYS IT MUST. `out/fig3_trackers.json caveats`:

    "LUC3D fragments MORE than SLEAP (+24.0 fragmentations per camera per session,
     95% CI [+18.3, +30.0]). Stated, not hidden."

`slap2m.fragmentations_paired` was deposited and appeared on NO panel in the figure --
a figure that otherwise prints every one of its method's losses (7d's negative 3- and
4-animal cells, 7e's essentially tied switch count, 7f's detection ceiling) was
silently dropping the one clean, corpus-wide result that goes against LUC3D. So it
gets its own panel, in SLEAP's colour, next to the other error panels.

WHAT A FRAGMENTATION IS AND WHY IT IS NOT AN ID SWITCH. motmetrics counts a
fragmentation each time a ground-truth track that was being tracked becomes untracked
and is later picked up again -- the identity is not reassigned to the wrong animal
(that is an ID switch, Fig 7e, where LUC3D and SLEAP are level at 3,710 vs 3,608), the
track simply breaks and resumes. For a proofreading tool that is a real cost: a broken
track is a gap the human has to bridge. LUC3D's 3D-consistency term is conservative
about accepting a detection into an existing identity, which is what buys it the
cross-view result in 7a and what costs it here.

THE EFFECT IS LARGE AND ONE-SIDED. +24.0 fragmentations per camera per session, 95%
CI [+18.3, +30.0] (bootstrap over the 74 sessions), median +14.1, and SLEAP fragments
less in 72 of the 74 sessions. Both the mean and the median are drawn because the
distribution is skewed -- the mean is 1.7x the median -- so quoting either alone
overstates or understates it.

Source: figs/out/fig3_trackers.json `slap2m.fragmentations_paired`, `caveats`.

    python3 figs/panels/fig7_08_fragmentations.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, INK, entity, deposit, panel, save,  # noqa: E402
                       use)

#: SLEAP's set-wide hue, via `entity()` rather than a local PERIWINKLE: this panel is
#: read against 7d's "SLEAP ahead" half and 7e's SLEAP bar, so it must be the SAME
#: periwinkle (review finding C3). Colour unchanged.
SLEAP = entity("sleap")
#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 49.4 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a pair buys nothing.
ROW_H = 47.0



def main():
    use()
    fp = load("fig3_trackers.json")["slap2m"]["fragmentations_paired"]
    n = fp["n_sessions"]
    luc_better = fp["wins"]          # sessions where LUC3D fragments LESS

    deposit(pd.DataFrame([{"statistic": "mean", "value": fp["mean"],
                           "ci95_lo": fp["ci95_lo"], "ci95_hi": fp["ci95_hi"]},
                          {"statistic": "median", "value": fp["median"],
                           "ci95_lo": None, "ci95_hi": None}]),
            7, "fig7g_fragmentations.csv")

    # 38 mm: the narrowest slot on the column grid that fits the label. One paired
    # difference is one datum -- a wide panel would be white space.
    fig, ax = panel(38.0, ROW_H)
    ax.axhline(0, color=INK, lw=0.8, zorder=1)
    # SLEAP's hue, matching 7d's "SLEAP ahead" half: colour carries who wins, and
    # SLEAP wins this one.
    ax.plot([0, 0], [fp["ci95_lo"], fp["ci95_hi"]], color=SLEAP, lw=1.2,
            zorder=3)
    ax.plot([0], [fp["mean"]], "o", color=SLEAP, ms=6, mec="white", mew=1.0,
            zorder=4)
    ax.plot([-0.16, 0.16], [fp["median"]] * 2, color=SLEAP, lw=1.2, zorder=3)

    top = fp["ci95_hi"] * 1.62
    ax.set_xlim(-0.7, 0.7)
    ax.set_ylim(-top * 0.17, top)
    ax.set_xticks([0])
    ax.set_xticklabels(["LUC3D − SLEAP"])
    ax.tick_params(axis="x", length=0)
    ax.set_ylabel("Δ fragmentations")
    # The numbers go in a LEFT-ALIGNED block in the empty band above the interval,
    # not beside their own marks: this panel is 38 mm wide, and a "median +14.1" set
    # to the right of the median rule ran off the page (the renderer drops the
    # overhang silently, so it has to be placed rather than caught).
    ax.text(-0.66, top * 0.99, "LUC3D fragments more", color=SLEAP, fontsize=6,
            fontweight="bold", va="top")
    ax.text(-0.66, top * 0.86,
            f"{fp['mean']:+.1f} [{fp['ci95_lo']:+.1f}, {fp['ci95_hi']:+.1f}]\n"
            f"median {fp['median']:+.1f}",
            color=SLEAP, fontsize=6, va="top", linespacing=1.35)
    # INK, not GREY: this line IS the panel's finding, and GREY (#B3B3B3) is a
    # series colour at 2.1:1 on white -- too light to carry a result.
    ax.text(-0.66, -top * 0.15, f"SLEAP fewer in {n - luc_better} of {n}",
            color=INK, fontsize=6, va="bottom")
    footnote(ax, f"per camera-session\nn = {n} sessions\nmean ± 95% CI")
    save(fig, 7, "g", "fragmentations")


if __name__ == "__main__":
    main()
