#!/usr/bin/env python3
"""
Fig 10d -- cross-view IDF1 under the three missingness axes, per dataset family.

The noise axis (10c) barely moves the tracker; MISSINGNESS is what degrades it,
and the three kinds degrade it differently -- which is the panel's one idea:

  instance   a whole animal absent from a view (detector miss), iid per
             (frame, view, animal), p in {10, 25, 50}%
  node       individual keypoints absent, iid per (frame, view, node),
             p in {25, 50}%
  occlusion  instance dropout CONDITIONED on another animal within 100 mm --
             the correlated missingness real rigs produce, q in {25, 50}%

All at sigma = 3 px on top. Lines are the POOLED (detection-weighted) IDF1 per
dataset, dots one per session -- same statistic switch as 10c (a per-session
median sat at 1.0 and ignored the tail; 2026-08-16 review). Same series
colors/markers and y scale as 10c so the two panels read as one sweep. The
sigma = 3 / no-dropout column is the leftmost "0".

Node dropout is the mildest (a 23-node skeleton is redundant for association);
uniform instance dropout is the harshest at 50% because half the anchor
evidence vanishes at random; occlusion-correlated dropout sits between --
concentrated where the animals interact, which is also where switches happen.

Source: figs/fig10-bench/results/agg/summary.csv.
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import use, grid, save, text_legend, DATASET_COLORS, MUTED

use()

AGG = Path(__file__).resolve().parent.parent / "fig10-bench" / "results" / "agg"
FAM = {"triads": "TRIADS", "bedding": "BEDDING", "soc1": "SCN2A", "soc3": "SCN2A"}
COLOR = DATASET_COLORS
MARKER = {"TRIADS": "o", "BEDDING": "s", "SCN2A": "^"}

KINDS = [
    # the 10% instance cell is measured (C2_drop0.1, in summary.csv) but not drawn:
    # its medians sit on 1.0 and its tick label collided with 0/25 at third-span
    # subpanel width. Nothing is hidden -- it is BETWEEN two drawn points.
    ("instance", {0.0: "C1_sigma3", 0.25: "C2_drop0.25", 0.5: "C2_drop0.5"}),
    ("node", {0.0: "C1_sigma3", 0.25: "C2b_nodedrop0.25", 0.5: "C2b_nodedrop0.5"}),
    ("occlusion", {0.0: "C1_sigma3", 0.25: "C3_occl0.25", 0.5: "C3_occl0.5"}),
]

vals = defaultdict(list)                       # (family, cell) -> [idf1]
wnum = defaultdict(float)
wden = defaultdict(float)
for r in csv.DictReader(open(AGG / "summary.csv")):
    k = (FAM[r["dataset"]], r["cell"])
    vals[k].append(float(r["idf1"]))
    w = int(r["n_gt_dets"])
    wnum[k] += float(r["idf1"]) * w
    wden[k] += w

fig, axes = grid(1, 3, span="third", row="std", sharey=True)
fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 3 + 0.02)))
rng = np.random.default_rng(0)
for ax, (kind, cells) in zip(axes, KINDS):
    rates = sorted(cells)
    xs = np.arange(len(rates))
    for fam in ["TRIADS", "BEDDING", "SCN2A"]:
        med = [wnum[(fam, cells[p])] / wden[(fam, cells[p])] for p in rates]
        ax.plot(xs, med, color=COLOR[fam], marker=MARKER[fam], markersize=3.5,
                linewidth=2.0, zorder=3)
        for i, p in enumerate(rates):
            v = vals[(fam, cells[p])]
            ax.scatter(np.full(len(v), i) + rng.uniform(-0.12, 0.12, len(v)), v,
                       s=4, color=COLOR[fam], alpha=0.3, linewidths=0, zorder=2)
    ax.set_xticks(xs)
    ax.set_xticklabels([f"{int(p * 100)}" for p in rates])
    ax.set_title(kind, fontsize=8, color=MUTED)
    ax.set_ylim(0.45, 1.02)
axes[0].set_ylabel("cross-view IDF1")
axes[1].set_xlabel("dropout (%), at σ = 3 px")
text_legend(axes[0], [("TRIADS", COLOR["TRIADS"]), ("BEDDING", COLOR["BEDDING"]),
                      ("SCN2A", COLOR["SCN2A"])], loc="above")
save(fig, 10, "d", "dropout")
