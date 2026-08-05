#!/usr/bin/env python3
"""
Fig 7f -- session IDF1 against the shared detector's recall.

THE HONEST CEILING. Every tracker in this figure is fed the SAME identity-stripped
detections, and this panel shows how much of a session's IDF1 is simply the
detector's recall: r = 0.975 for LUC3D, 0.949 for SLEAP, one point per session.

Read with Fig 7e: false negatives are 98.8-99.3% of every tracker's error budget.
Association is what separates the trackers, but the level is set by detection, and
a figure that only showed the separation would oversell it.

Points ABOVE the IDF1 = recall diagonal are sessions where the tracker kept
identity on essentially every detection it was given.

BYTETRACK'S CORRELATION IS NOW ON THE PANEL, and it is the one number here that
cuts against the panel's own claim. `detector_recall_corr` deposits
bytetrack r = 0.780, R2 = 0.608 -- much weaker than LUC3D's 0.975 or SLEAP's 0.949.
A tracker whose session IDF1 is only loosely tied to recall is a tracker whose OWN
failures dominate, so "the level is set by detection" is a statement about the two
good trackers, not a law. Leaving it out made the claim look more general than the
data supports.

WHY ITS POINTS ARE NOT DRAWN. They cannot be. `detector_recall_corr.per_session`
deposits four columns -- recall, LUC3D IDF1, SLEAP IDF1, animal count -- and no
ByteTrack column; ByteTrack's per-session IDF1 survives only in
`within_view.bytetrack.per_session`, which the generator stores SORTED, so session
identity is gone and no point can be paired with its recall. The r is exact and is
printed; the scatter would have to be invented. Re-run `fig3_trackers.py` with a
bytetrack column in `per_session` if the cloud is wanted.

Source: figs/out/fig3_trackers.json `slap2m.detector_recall_corr`.

    python3 figs/panels/fig7_07_recall.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, PERIWINKLE, SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, text_legend, use)


def main():
    use()
    d = load("fig3_trackers.json")["slap2m"]["detector_recall_corr"]
    per = np.asarray(d["per_session"], float)
    # Columns are [recall, luc3d IDF1, sleap IDF1, n_animals]. VERIFIED, not
    # assumed: corr(col0, col1) = 0.975 and corr(col0, col2) = 0.949 reproduce the
    # deposited r values exactly, which pins the order.
    recall, luc, sle = per[:, 0], per[:, 1], per[:, 2]

    deposit(pd.DataFrame({"detector_recall": recall, "luc3d_idf1": luc,
                          "sleap_idf1": sle}), 7, "fig7f_recall.csv")

    # Everything that names something lives in the reserved band ABOVE the plot.
    # Inside the axes there is nowhere for it to go: the cloud hugs the diagonal
    # over the whole range, so the "IDF1 = recall" label -- set along the line --
    # printed on the line, and the two r values were a single teal block that
    # coloured SLEAP's r as if it were LUC3D's.
    entries = [(f"LUC3D r = {d['luc3d']['r']:.3f}", TEAL),
               (f"SLEAP r = {d['sleap']['r']:.3f}", PERIWINKLE),
               (f"ByteTrack r = {d['bytetrack']['r']:.3f} (not plotted)", SALMON),
               ("dashed: IDF1 = recall", GREY)]
    # 54 mm: this row carries three panels (e, f, g) and must sum to 180 mm.
    fig, ax = panel(54.0, "std", key=len(entries))
    ax.plot([0, 1], [0, 1], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)), zorder=1)
    ax.plot(recall, sle, "o", color=PERIWINKLE, ms=3, alpha=0.8, zorder=3)
    ax.plot(recall, luc, "o", color=TEAL, ms=3, alpha=0.8, zorder=4)
    text_legend(ax, entries, "above")
    ax.set_xlabel("shared detector recall")
    ax.set_ylabel("session IDF1")
    ax.set_xlim(0, 1.02)
    ax.set_ylim(0, 1.02)
    ax.set_xticks([0, 0.5, 1.0])
    ax.set_yticks([0, 0.5, 1.0])
    footnote(ax, f"one point per session, n = {len(recall)}\n"
             f"LUC3D R² = {d['luc3d']['r2']:.2f}\n"
             "ByteTrack pairing not deposited")
    save(fig, 7, "f", "recall")


if __name__ == "__main__":
    main()
