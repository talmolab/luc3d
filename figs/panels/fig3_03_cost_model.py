#!/usr/bin/env python3
"""
Fig 3c -- what exhaustive multi-view association costs: (A!)^C hypotheses per frame.

CREDIT WHERE IT IS DUE. The exhaustive method is Maree, Afshar, Oline, Leonardis,
Falkner & Pereira (2024), "Multi-view triangulation-enabled annotation for
multi-animal 3D pose in SLEAP", Proc. Measuring Behavior 2024, 217-224: enumerate
every grouping of instances into identities, triangulate and reproject each, keep
the lowest-reprojection grouping. Its cost is (A!)^C hypotheses per frame for A
animals and C cameras -- A! per view, raised to the number of views. That paper's
own "Future directions ▸ Faster multi-view association" proposes the GREEDY variant
which hard-commits each view's assignment, and that is exactly what LUC3D's
per-view Hungarian does. So this panel answers a question that paper poses.

ONE QUANTITY ON THE AXIS, AND ONLY ONE. An earlier version of this panel drew a
fifth, grey curve for LUC3D at C · A^3 -- the Hungarian solver's operation count --
on an axis labelled "hypotheses per frame". Those are different units, and the
consequence was a false claim on the artwork: at A = 1 the grey curve sat at 8 while
every exhaustive curve sat at 1, i.e. the chart stated that the greedy solve costs
8x MORE than enumerating everything. It does not; it enumerates NO hypotheses at
all. The greedy cost is therefore stated in words under the axis and MEASURED in
panel d, where it belongs, and this axis carries exactly the quantity it names.
(The panel's own docstring already forbade mixing an analytic count with a
wall-clock timing on one axis; two analytic counts of different things is the same
error.)

THE AXIS MUST REACH THE WORST CASE. `ylim` used to top out at 1e20 while the
8-camera curve reaches (6!)^8 = 7.2e22 at A = 6, so the curve left the axes at
A ~ 5.5 and the worst case -- the whole point of the panel -- was a missing marker.
The limit is now 1e24, which also puts the 10^6 rule on a tick.

The curves are ANALYTIC: closed-form hypothesis counts, not timings. Panels d and f
carry measured time. Keeping them apart matters -- an analytic count and a
wall-clock measurement have different failure modes and must not share an axis.

Source: figs/out/fig3_runtime.json `analytic_exhaustive` (provenance; the counts are
exact arithmetic) and `fig3_headtohead.json caps` for the 10^6 rule.

    python3 figs/panels/fig3_03_cost_model.py
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (SALMON, SET2, deposit, footnote,  # noqa: E402
                       panel, save, text_legend, use)

CAMERAS = [2, 4, 6, 8]
ANIMALS = list(range(1, 7))

#: Unicode superscript digits, so "10^6" can be set in the axis label's own font
#: rather than as mathtext (which would switch families mid-label).
_SUPS = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


def _sup(n) -> str:
    return str(n).translate(_SUPS)


def build() -> pd.DataFrame:
    load("fig3_runtime.json")          # provenance: same run the measured panel uses
    rows = []
    for c in CAMERAS:
        for a in ANIMALS:
            rows.append({
                "cameras": c, "animals": a,
                "exhaustive": math.factorial(a) ** c,
                # The greedy solve's operation count, DEPOSITED but not plotted --
                # see the docstring. It is in the CSV so the comparison the footnote
                # states in words is still auditable against a file in the repo.
                "greedy_hungarian_ops": c * a ** 3,
                "greedy_hypotheses": 0,
            })
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 3, "fig3c_cost_model.csv")

    #: The harness's own ceiling, from the head-to-head deposit, so the rule on this
    #: panel and the "not run" point in panel f are the SAME number.
    cap = load("fig3_headtohead.json")["caps"]["max_hypotheses_per_frame"]

    # key=4, one per camera count. The band panel() reserves has to match the number
    # of entries actually stacked in it: keyed too small, the last entries fall out
    # of the band and land on the top tick label and the data.
    fig, ax = panel("half", "std", key=4)
    for i, c in enumerate(CAMERAS):
        g = df[df.cameras == c]
        ax.plot(g.animals, g.exhaustive, color=SET2[i], lw=2.0, zorder=3)
        ax.plot(g.animals, g.exhaustive, "o", color=SET2[i], ms=4, mec="white",
                mew=0.8, zorder=4)

    # A tractability rule, so the axis has a meaning a reader can act on.
    ax.axhline(cap, color=SALMON, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)

    # NO TEXT INSIDE THESE AXES, and that is deliberate rather than timid. Four
    # curves over 24 decades leave no gap wide enough for a label, and
    # "10^6 hypotheses/frame" is ~90 pt of type: at the one height it belongs --
    # just above the rule -- the 8-, 6- and 4-camera curves punch through it at
    # A = 3.0, 3.4 and 4.2. The rule is therefore named in the footnote, BY WHAT IT
    # IS rather than by its colour (a caption that says "the salmon rule" is unusable
    # to a colourblind reader and reads as internal shorthand).
    text_legend(ax, [(f"{c} cameras", SET2[i]) for i, c in enumerate(CAMERAS)],
                "above")
    ax.set_yscale("log")
    ax.set_xticks(ANIMALS)
    ax.set_xlabel("animals")
    ax.set_ylabel("hypotheses per frame")
    ax.set_ylim(1, 1e24)
    ax.set_yticks(np.logspace(0, 24, 5))
    # AFTER set_xlabel, not before: footnote() APPENDS to the current x label, so a
    # later set_xlabel silently throws the note away.
    footnote(ax, f"dotted rule: the harness's 10{_sup(round(math.log10(cap)))} "
                 "hypotheses/frame cap\n"
                 "greedy (LUC3D) enumerates none: C solves per frame")
    save(fig, 3, "c", "cost_model")


if __name__ == "__main__":
    main()
