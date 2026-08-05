#!/usr/bin/env python3
"""
Fig 7b -- bedding invariance: does the tracker survive a change of background?

White mice on white bedding is the hard case; black bedding is the easy one. The
SAME identity-stripped detections feed every tracker, and detector recall barely
moves between the two conditions (delta 0.004), so any drop is the TRACKER's, not
the detector's. That control is drawn as the fourth, grey pair.

LUC3D loses 0.012, SLEAP 0.079, ByteTrack 0.148. The reason is geometric: LUC3D's
association is dominated by the 3D term (Fig 3d), which does not care what the
bedding looks like, while a per-camera appearance/motion tracker degrades with
contrast.

THIS IS A BETWEEN-SESSION COMPARISON AND IS NOW DRAWN AS ONE. An earlier version was
a slopegraph: one line per tracker joining its black-bedding score to its
white-bedding score. That shape means a repeated measure -- the same units under two
conditions -- and these are not. `by_bedding` is n = 44 BLACK sessions and n = 30
WHITE ones: 74 different recordings split into two groups, never the same session
under two beddings. The line implied a pairing that does not exist, so the panel is
now grouped bars (solid = black, open = white), an idiom that cannot be read as
paired.

THE OTHER CONFOUND IS PRINTED TOO, because ruling out the detector does not rule out
everything else. `paired_vs_sleap[*].bedding` deposits the animal-count composition of
each group: the black group is 21/44 single-animal, the white group 11/30, and the two
groups also differ in difficulty. The recall control (delta 0.004) rules out a
DETECTION confound only. There are no intervals because the deposit carries one pooled
IDF1 per condition, not per-session values.

Source: figs/out/fig3_trackers.json `slap2m.by_bedding`, `slap2m.paired_vs_sleap`.

    python3 figs/panels/fig7_06_bedding.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, entity, deposit, panel,  # noqa: E402
                       save, use)

#: Hues from `entity()` -- one hue per tracker set-wide, resolved in one place rather
#: than re-picked in each of the seven panels (review finding C3). Unchanged colours.
#: The detector-recall control below stays GREY on purpose: it is not a tracker, and
#: GREY is this set's colour for a reference level rather than a method.
TRACKERS = [("luc3d", "LUC3D", entity("luc3d")),
            ("sleap", "SLEAP", entity("sleap")),
            ("bytetrack", "ByteTrack", entity("bytetrack"))]
CONDS = ["black", "white"]
#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 50.0 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a pair buys nothing.
ROW_H = 47.0

BAR_W = 0.34


def main():
    use()
    t = load("fig3_trackers.json")
    bb = t["slap2m"]["by_bedding"]
    pv = t["slap2m"]["paired_vs_sleap"]

    # Groups: the three trackers, then the shared detector as the control. The
    # control is a rate on the same 0-1 axis, which is why the legacy panel drew it
    # here rather than in a panel of its own.
    groups = [(lab, color, [bb[c][k]["idf1"] for c in CONDS])
              for k, lab, color in TRACKERS]
    groups.append(("detector\nrecall", GREY,
                   [bb[c]["detector_recall"] for c in CONDS]))

    rows = []
    fig, ax = panel("half", ROW_H)
    x = np.arange(len(groups))
    for i, (lab, color, ys) in enumerate(groups):
        # Solid = black bedding, open = white bedding. The fills are a mnemonic for
        # the condition, and no bar touches another group's, so nothing here can be
        # mistaken for a within-session change.
        ax.bar(i - BAR_W / 2, ys[0], width=BAR_W, color=color, zorder=2)
        ax.bar(i + BAR_W / 2, ys[1], width=BAR_W, facecolor="white",
               edgecolor=color, lw=0.9, zorder=2)
        ax.text(i, max(ys) + 0.035, f"Δ{ys[0] - ys[1]:.3f}", ha="center",
                va="bottom", color=color, fontsize=6.5, fontweight="bold")
        rows += [{"series": lab.replace("\n", " "), "bedding": c, "value": y,
                  "n_sessions": bb[c]["n_sessions"]} for c, y in zip(CONDS, ys)]

    deposit(pd.DataFrame(rows), 7, "fig7b_bedding.csv")
    ax.set_xticks(x)
    ax.set_xticklabels([lab for lab, _, _ in groups])
    ax.tick_params(axis="x", length=0)
    ax.set_xlim(-0.62, len(groups) - 0.38)
    ax.set_ylabel("IDF1  /  recall")
    ax.set_ylim(0, 0.95)

    # The animal-count composition of the two groups, from the deposited per-animal
    # bedding counts -- the confound a reader has to be told about.
    one = pv["1"]["bedding"]
    nb, nw = bb["black"]["n_sessions"], bb["white"]["n_sessions"]
    # FOUR SHORT LINES. The x label is centred on the axes, so a line wider than the
    # axis extent hangs off the page and the renderer silently drops the overhang --
    # at 7.5 pt (what `footnote` sets) the two-clause versions of lines 2 and 3
    # measured 77 and 79 mm on an 88 mm panel and lost their opening words. Nothing
    # here is dropped: every line is under 74 mm.
    footnote(ax,
             f"solid = black bedding (n = {nb}) · open = white bedding (n = {nw})\n"
             "BETWEEN-SESSION: different sessions, not paired\n"
             f"animal mix differs too (1 animal {one['black']}/{nb} vs "
             f"{one['white']}/{nw})\n"
             "no per-session values deposited, so no intervals")
    save(fig, 7, "b", "bedding")


if __name__ == "__main__":
    main()
