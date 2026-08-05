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

Source: figs/out/fig3_trackers.json `slap2m.detector_recall_corr`.

    python3 figs/panels/fig7_07_recall.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import footnote, GREY, PERIWINKLE, TEAL, deposit, panel, save, text_legend, use  # noqa: E402


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

    fig, ax = panel("half", "std")
    ax.plot([0, 1], [0, 1], color=GREY, lw=0.9, ls=(0, (2.5, 1.5)), zorder=1)
    ax.text(0.62, 0.56, "IDF1 = recall", color=GREY, fontsize=6.5, rotation=38)
    ax.plot(recall, sle, "o", color=PERIWINKLE, ms=3, alpha=0.8, zorder=3)
    ax.plot(recall, luc, "o", color=TEAL, ms=3, alpha=0.8, zorder=4)

    ax.text(0.03, 0.97, f"LUC3D r = {d['luc3d']['r']:.3f}\nSLEAP r = {d['sleap']['r']:.3f}",
            transform=ax.transAxes, va="top", fontsize=6.5, color=TEAL,
            fontweight="bold")
    ax.set_xlabel("shared detector recall")
    ax.set_ylabel("session IDF1")
    ax.set_xlim(0, 1.02)
    ax.set_ylim(0, 1.02)
    footnote(ax, f"one point per session, n = {len(recall)}")
    save(fig, 7, "f", "recall")


if __name__ == "__main__":
    main()
