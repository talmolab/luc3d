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

NOTE SLEAP'S SWITCH COUNT IS ESSENTIALLY LUC3D'S (3,608 vs 3,710) -- LUC3D does not
win on within-view switches, and the panel does not pretend otherwise. Its advantage
is cross-view (Fig 7a) and under changing background (Fig 7b).

Source: figs/out/fig3_trackers.json `slap2m.error_decomposition`.

    python3 figs/panels/fig7_03_error_decomposition.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, PERIWINKLE, SALMON, TEAL, deposit, panel, save,  # noqa: E402
                       text_legend, use)

TRACKERS = [("luc3d", "LUC3D", TEAL), ("sleap", "SLEAP", PERIWINKLE),
            ("bytetrack", "ByteTrack", SALMON)]
TERMS = [("false_positives", "false positives"), ("id_switches", "ID switches")]


def main():
    use()
    ed = load("fig3_trackers.json")["slap2m"]["error_decomposition"]

    df = pd.DataFrame([{"tracker": lab, "term": name, "count": ed[k][key],
                        "fn_share": ed[k]["fn_share"]}
                       for k, lab, _ in TRACKERS for key, name in TERMS])
    deposit(df, 7, "fig7e_error_decomposition.csv")

    fig, ax = panel("half", "std", key=1)
    x = np.arange(len(TERMS))
    w = 0.26
    for i, (k, lab, color) in enumerate(TRACKERS):
        vals = [ed[k][key] / 1e3 for key, _ in TERMS]
        pos = x + (i - 1) * w
        ax.bar(pos, vals, width=w, color=color, zorder=2)
        for px, v in zip(pos, vals):
            ax.text(px, v + 1.5, f"{v * 1e3 / 1e3:.1f}k", ha="center", va="bottom",
                    color=color, fontsize=6, fontweight="bold")

    text_legend(ax, [(lab, c) for _, lab, c in TRACKERS], "above")
    ax.set_xticks(x)
    ax.set_xticklabels([n for _, n in TERMS])
    ax.set_ylabel("errors (thousands)")
    ax.set_ylim(0, max(ed[k]["false_positives"] for k, _, _ in TRACKERS) / 1e3 * 1.30)
    lo = min(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    hi = max(ed[k]["fn_share"] for k, _, _ in TRACKERS)
    footnote(ax, f"{ed['luc3d']['gt_instances']:,} ground-truth instances\n"
            f"false negatives are {lo:.1%}–{hi:.1%} of every tracker's error")
    save(fig, 7, "e", "decomposition")


if __name__ == "__main__":
    main()
