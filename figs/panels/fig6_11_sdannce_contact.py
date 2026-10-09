#!/usr/bin/env python3
"""
Fig 6i -- identity holds through close contact; the few losses sit at
near-coincident source tracks.

One point per session at sigma = 0 on the full rig: x is the number of frames
in which two animals' 3D centroids are within 50 mm (close contact, log axis),
y is cross-view IDF1. Sessions with an identity swap are drawn filled and
labelled with how close the two swapped animals' source 3D tracks came within
50 frames of the swap (`results/agg/swapdiag/`). Four of the five are under
6 mm. The BEDDING swap is at 45 mm, during a body-overlap contact.

Source: figs/fig10-bench/results/agg/panel_10f_merge.json.

    python3 figs/panels/fig6_11_sdannce_contact.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import DATASET_COLORS, deposit, footnote, panel, save, use  # noqa: E402
from fig6_08_sdannce_common import DATASETS, proximity, swap_distance  # noqa: E402

ROW_H = 50.0
MARKERS = {"TRIADS": "o", "BEDDING": "s", "SCN2A": "^"}
#: the two ~0.97 sessions sit side by side; send one label left and down
LABEL_OFFSET = {"2024_05_07_F6_F2": (-5, -8), "2022_10_04_M3_M4": (5, -8)}


def main():
    use()
    rows = proximity()
    df = pd.DataFrame(rows)
    at_swap = swap_distance()
    df["swap_dist_mm"] = df.session.map(at_swap)
    deposit(df[["dataset", "session", "animals", "frames", "frames_lt50mm",
                "frames_lt20mm", "min_pair_mm", "idf1_sigma0",
                "switches_sigma0", "swap_dist_mm"]], 6,
            "fig6i_sdannce_contact.csv")

    fig, ax = panel("third", ROW_H)
    for d in DATASETS:
        s = df[df.dataset == d]
        clean = s[s.switches_sigma0 == 0]
        swap = s[s.switches_sigma0 > 0]
        ax.scatter(clean.frames_lt50mm.clip(lower=1), clean.idf1_sigma0,
                   s=14, facecolor="none", edgecolor=DATASET_COLORS[d],
                   lw=0.9, marker=MARKERS[d], zorder=3)
        ax.scatter(swap.frames_lt50mm.clip(lower=1), swap.idf1_sigma0,
                   s=20, color=DATASET_COLORS[d], marker=MARKERS[d],
                   edgecolor="white", lw=0.5, zorder=4)
        for _, r in swap.iterrows():
            if r.idf1_sigma0 < 0.99:
                ax.annotate(f"{r.swap_dist_mm:.1f} mm",
                            (max(r.frames_lt50mm, 1), r.idf1_sigma0),
                            xytext=LABEL_OFFSET.get(r.session, (5, 0)),
                            textcoords="offset points", fontsize=6.5,
                            va="center", ha="left" if LABEL_OFFSET.get(
                                r.session, (5, 0))[0] > 0 else "right",
                            color=DATASET_COLORS[d])
    ax.set_xscale("log")
    ax.set_ylim(0.6, 1.02)
    ax.set_xlabel("frames with animals < 50 mm apart")
    ax.set_ylabel("cross-view IDF1")
    clean = df[df.switches_sigma0 == 0]
    footnote(ax, f"{len(clean)}/41 sessions with zero switches hold "
                 f"{int(clean.frames_lt50mm.sum()):,} frames < 50 mm and "
                 f"{int(clean.frames_lt20mm.sum()):,} frames < 20 mm; "
                 "labels: closest approach of the swapped tracks within 50 frames of the swap")
    save(fig, 6, "i", "sdannce_contact")


if __name__ == "__main__":
    main()
