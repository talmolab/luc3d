#!/usr/bin/env python3
"""
Fig 7 supplementary -- per-session IDF1 for the three trackers, across SLAP-2M.

NOT a main-figure panel: 7a is now the within-vs-cross-view slopegraph, which is the
finding. This is the raw within-view distribution behind 7c's survival curve, kept
because the median + spread is worth having somewhere.

The headline comparison. One box per tracker over the 74 sessions, with every
session's own score behind it, so the pooled medians carry a visible spread -- these
are 74 recordings of very different difficulty (Fig 6c), not 74 draws from one
distribution.

WHICH NUMBERS THESE ARE, because `luc3d-bench/outputs/metrics/` holds three
different runs in one directory (LUC3D IDF1 0.738301 / 0.736490 / 0.7383 depending
on the file) and `PAF_3d_kalman/metrics/headline.csv` shows the shipped baseline at
0.73604 against a PAF-L1 VARIANT at 0.73809. Cells labelled "luc3d" in that
directory therefore sit closest to the variant, NOT the shipped tool. This panel
reads `fig3_trackers.json`, whose `provenance.shipped_configuration` names the one
file that was chosen and why -- so the figure cannot drift back onto the variant.
Print that field before quoting any number from here.

Source: figs/out/fig3_trackers.json `slap2m.within_view[*].per_session`.

    python3 figs/panels/fig7_04_trackers.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, GREY, INK, entity, deposit, panel,  # noqa: E402
                       save, use)

#: Hues from `entity()` -- one hue per tracker set-wide (review finding C3),
#: unchanged colours.
TRACKERS = [("luc3d", "LUC3D", entity("luc3d")),
            ("sleap", "SLEAP", entity("sleap")),
            ("bytetrack", "ByteTrack", entity("bytetrack"))]


def main():
    use()
    t = load("fig3_trackers.json")
    wv = t["slap2m"]["within_view"]
    print(f"  provenance: {t['provenance']['shipped_configuration']}")

    rows = []
    for key, label, _ in TRACKERS:
        for v in wv[key]["per_session"]:
            rows.append({"tracker": label, "idf1": v})
    df = pd.DataFrame(rows)
    deposit(df, 7, "fig7a_trackers.csv")

    fig, ax = panel("third", "std")
    rng = np.random.default_rng(0)     # fixed: jitter must not move between runs
    for i, (key, label, color) in enumerate(TRACKERS):
        v = np.asarray(wv[key]["per_session"])
        ax.boxplot([v], positions=[i], widths=0.5, showfliers=False,
                   manage_ticks=False, patch_artist=True,
                   boxprops=dict(facecolor=color, alpha=0.35, edgecolor=INK, lw=0.8),
                   medianprops=dict(color=color, lw=2.0),
                   whiskerprops=dict(color=INK, lw=0.8),
                   capprops=dict(color=INK, lw=0.8))
        ax.plot(i + rng.uniform(-0.13, 0.13, len(v)), v, "o", color=color, ms=2.2,
                alpha=0.55, zorder=3)
        ax.text(i, 1.02, f"{np.median(v):.3f}", ha="center", va="bottom",
                color=color, fontweight="bold", fontsize=7)

    ax.set_xticks(range(len(TRACKERS)))
    ax.set_xticklabels([lab for _, lab, _ in TRACKERS])
    ax.set_ylabel("IDF1, within view")
    ax.set_ylim(0, 1.10)
    ax.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
    footnote(ax, f"{wv['luc3d']['n_sessions']} SLAP-2M sessions")
    save(fig, 7, "s1", "trackers_by_session")


if __name__ == "__main__":
    main()
