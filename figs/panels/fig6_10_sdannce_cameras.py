#!/usr/bin/env python3
"""
Fig 6h -- how many cameras identity needs on the social-DANNCE rats, no noise.

Same reprojected, slot-shuffled input as panel g, re-run on fixed camera
subsets of the six-camera rig (k = 2 is an opposite pair; subsets are the
benchmark's maximally spread selections). Y is the % of sessions that finish
at IDF1 >= PERFECT, one line per dataset.

Only the sigma = 0 cells (C7c_*, and C1 for k = 6). The noisy and dropout
camera arms (C7, C7b, C7d-f) stay in the deposit.

Source: figs/fig10-bench/results/agg/summary.csv.

    python3 figs/panels/fig6_10_sdannce_cameras.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import DATASET_COLORS, INK, deposit, footnote, panel, save, use  # noqa: E402
from fig6_08_sdannce_common import (CAMERA_CELLS, DATASETS, PERFECT,  # noqa: E402
                                    cell)

ROW_H = 50.0
MARKERS = {"TRIADS": "o", "BEDDING": "s", "SCN2A": "^", "all": "D"}
#: small horizontal dodge so datasets with equal values (TRIADS and BEDDING are
#: both 5 of 6 at every k) do not hide one another
DODGE = {"TRIADS": -0.12, "BEDDING": 0.0, "SCN2A": 0.12, "all": 0.0}


def main():
    use()
    out = []
    for k, name in CAMERA_CELLS.items():
        rows = cell(name)
        for d in DATASETS + ["all"]:
            sel = [r for r in rows if d == "all" or r["dataset"] == d]
            dets = sum(r["n_gt_dets"] for r in sel)
            out.append({"cameras": k, "dataset": d, "n": len(sel),
                        "pct_perfect": 100.0 * sum(r["idf1"] >= PERFECT
                                                   for r in sel) / len(sel),
                        "pooled_idf1": sum(r["idf1"] * r["n_gt_dets"]
                                           for r in sel) / dets,
                        "switches": sum(r["switches"] for r in sel)})
    df = pd.DataFrame(out)
    deposit(df, 6, "fig6h_sdannce_cameras.csv")

    fig, ax = panel("third", ROW_H)
    for d in DATASETS + ["all"]:
        s = df[df.dataset == d].sort_values("cameras")
        color = INK if d == "all" else DATASET_COLORS[d]
        ax.plot(s.cameras + DODGE[d], s.pct_perfect, color=color, marker=MARKERS[d],
                ms=4, lw=2.2 if d == "all" else 1.4, mec="white", mew=0.6,
                zorder=4 if d == "all" else 3)
    ax.set_xticks(sorted(CAMERA_CELLS))
    ax.set_xlim(1.7, 6.3)
    ax.set_ylim(0, 102)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_xlabel("cameras used")
    ax.set_ylabel(f"% of sessions with\nIDF1 ≥ {PERFECT}")
    allr = df[df.dataset == "all"].set_index("cameras")
    footnote(ax, "all datasets, % perfect by k: "
             + ", ".join(f"{k}: {allr.pct_perfect[k]:.0f}%" for k in allr.index)
             + "; pooled IDF1 by k: "
             + ", ".join(f"{k}: {allr.pooled_idf1[k]:.3f}" for k in allr.index))
    save(fig, 6, "h", "sdannce_cameras")


if __name__ == "__main__":
    main()
