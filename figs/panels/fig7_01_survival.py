#!/usr/bin/env python3
"""
Fig 7c -- IDF1 survival across the SLAP-2M corpus.

THIS PANEL REPLACED A DOT SWARM, and the change is substantive, not cosmetic. As
444 jittered dots the finding was invisible; as a survival curve -- the percentage
of sessions scoring at or above each IDF1 threshold -- it is a vertical distance at
any threshold the reader cares to pick.

The trackers separate most in the UPPER TAIL, which both a median bar and a jittered
cloud bury: at IDF1 >= 0.9 the counts are LUC3D 36/74, SLEAP 22/74, ByteTrack 10/74.

The curve is drawn from every session's own IDF1, so it is a true ECDF over the 74
sessions rather than an interpolation through the five deposited thresholds; those
thresholds are marked so the numbers in the caption can be read straight off.

Source: figs/out/fig3_trackers.json `slap2m.within_view[*].per_session`.

    python3 figs/panels/fig7_01_survival.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, PERIWINKLE, SALMON, TEAL, deposit, panel, save,  # noqa: E402
                       text_legend, use)

TRACKERS = [("luc3d", "LUC3D", TEAL), ("sleap", "SLEAP", PERIWINKLE),
            ("bytetrack", "ByteTrack", SALMON)]
MARK = 0.9


def main():
    use()
    wv = load("fig3_trackers.json")["slap2m"]["within_view"]

    rows = []
    # key=3, one reserved row per entry: at key=1 the band was a third of the height
    # the three-name stack needs, so "SLEAP" and "ByteTrack" fell inside the axes,
    # onto the 100 % y tick label and onto the curves themselves.
    fig, ax = panel("third", "std", key=len(TRACKERS))
    for key, label, color in TRACKERS:
        v = np.sort(np.asarray(wv[key]["per_session"]))
        n = len(v)
        # Survival: % of sessions at or above each threshold. Step-post, because
        # the value is constant until the next session's score is passed.
        surv = 100.0 * (n - np.arange(n)) / n
        ax.step(v, surv, where="post", color=color, lw=2.0, zorder=3)
        atmark = 100.0 * (v >= MARK).sum() / n
        rows += [{"tracker": label, "idf1": float(x), "survival_pct": float(s)}
                 for x, s in zip(v, surv)]
        ax.plot([MARK], [atmark], "o", color=color, ms=5, mec="white", mew=1.0,
                zorder=4)

    deposit(pd.DataFrame(rows), 7, "fig7c_survival.csv")

    ax.axvline(MARK, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    # Counts in fixed rows to the right of the rule: at their own curve heights the
    # three values sit within ~35 points of each other and overprinted the strokes.
    for i, (key, label, color) in enumerate(TRACKERS):
        v = np.asarray(wv[key]["per_session"])
        # Lower LEFT: the curves all sit high at low thresholds, so this corner is
        # the only reliably empty one. Against the right-hand rule the three counts
        # landed on the strokes they describe.
        ax.text(0.03, 0.26 - i * 0.09,
                f"{label} {int((v >= MARK).sum())}/{len(v)}",
                transform=ax.transAxes, ha="left", color=color, fontsize=7,
                fontweight="bold")
    ax.text(MARK - 0.015, 96, f"IDF1 ≥ {MARK}", color=GREY, fontsize=7, ha="right",
            rotation=90, va="top")

    text_legend(ax, [(lab, c) for _, lab, c in TRACKERS], "above")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 100)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_xlabel("IDF1 threshold")
    ax.set_ylabel("% of sessions at or above")
    save(fig, 7, "c", "survival")


if __name__ == "__main__":
    main()
