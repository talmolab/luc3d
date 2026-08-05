#!/usr/bin/env python3
"""
Fig 7e -- error composition: false positives and ID switches, in counts.

FALSE NEGATIVES ARE DELIBERATELY NOT PLOTTED, and the caption must say why. They are
98.8-99.3% of every tracker's error budget, so a chart including them shows three
identical bars and hides the terms a tracker actually controls. The FN share is
stated in the footer instead; the bars are the controllable remainder.

An earlier version plotted all three SHARES on a log axis. That was legible but
answered the wrong question: shares of a budget dominated by detection say more
about the detector than the tracker. Counts of the controllable errors are what
separate the trackers -- ID switches LUC3D 3,710 against ByteTrack 12,305 on the
same 15,947,278 ground-truth instances, a 3.3x reduction.

EXACT COUNTS, NOT "3.7k". The bars were labelled to one decimal in thousands, which
rounded away the two comparisons the panel exists to support: SLEAP's switch count is
essentially LUC3D's (3,608 vs 3,710 -- as "3.6k" vs "3.7k" that reads as a 3%
difference on numbers rounded to +-50), and ByteTrack's 3.3x ratio is not recoverable
from "12.3k / 3.7k". The full integers are printed.

NOTE LUC3D DOES NOT WIN ON WITHIN-VIEW SWITCHES, and the panel does not pretend
otherwise: SLEAP's 3,608 is fractionally better. LUC3D's advantage is cross-view
(Fig 7a) and under changing background (Fig 7b) -- and it fragments MORE than SLEAP,
which is the panel next door (Fig 7g).

Source: figs/out/fig3_trackers.json `slap2m.error_decomposition`.

    python3 figs/panels/fig7_03_error_decomposition.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, entity, deposit, panel, save,  # noqa: E402
                       text_legend, use)

#: Hues from `entity()` -- one hue per tracker across the whole set, resolved in one
#: place instead of re-picked per panel (review finding C3). Colours unchanged.
TRACKERS = [("luc3d", "LUC3D", entity("luc3d")),
            ("sleap", "SLEAP", entity("sleap")),
            ("bytetrack", "ByteTrack", entity("bytetrack"))]
TERMS = [("false_positives", "false positives"), ("id_switches", "ID switches")]
BAR_W = 0.26
#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 50.0 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a pair buys nothing.
ROW_H = 47.0



def main():
    use()
    ed = load("fig3_trackers.json")["slap2m"]["error_decomposition"]

    df = pd.DataFrame([{"tracker": lab, "term": name, "count": ed[k][key],
                        "fn_share": ed[k]["fn_share"]}
                       for k, lab, _ in TRACKERS for key, name in TERMS])
    deposit(df, 7, "fig7e_error_decomposition.csv")

    # 80 mm rather than a half: this row now carries three panels (e, f, g) and the
    # six exact counts need the width. At 88 mm the row would not fit 180 mm.
    fig, ax = panel(80.0, ROW_H, key=1)
    top = max(ed[k]["false_positives"] for k, _, _ in TRACKERS) * 1.30
    x = np.arange(len(TERMS))
    for i, (k, lab, color) in enumerate(TRACKERS):
        vals = [ed[k][key] for key, _ in TERMS]
        pos = x + (i - 1) * BAR_W
        ax.bar(pos, [v / 1e3 for v in vals], width=BAR_W, color=color, zorder=2)
        for j, (px, v) in enumerate(zip(pos, vals)):
            # The two switch counts differ by 3% (3,710 vs 3,608), so their labels
            # would sit at the same height on adjacent bars. Stagger the middle
            # tracker upward; the FP group is spread enough not to need it.
            lift = 0.055 if (j == 1 and i == 1) else 0.0
            ax.text(px, v / 1e3 + (0.02 + lift) * top / 1e3, f"{v:,}", ha="center",
                    va="bottom", color=color, fontsize=6, fontweight="bold")

    text_legend(ax, [(lab, c) for _, lab, c in TRACKERS], "above")
    ax.set_xticks(x)
    ax.set_xticklabels([n for _, n in TERMS])
    ax.set_xlim(-0.45, len(TERMS) - 0.55)
    ax.set_ylabel("errors (thousands)")
    ax.set_ylim(0, top / 1e3)
    lo = min(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    hi = max(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    footnote(ax, f"{ed['luc3d']['gt_instances']:,} ground-truth instances\n"
             f"false negatives: {lo:.1%}–{hi:.1%} of every tracker's error")
    save(fig, 7, "e", "decomposition")


if __name__ == "__main__":
    main()
