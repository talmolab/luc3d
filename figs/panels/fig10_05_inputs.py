#!/usr/bin/env python3
"""
Fig 10e -- does the reID need a skeleton, or do centroids carry it?
Full 23-node keypoints vs a single COM point per animal, at sigma = 0 (noiseless
2D -- condition set by Eric 2026-08-16; the sigma = 3 variant showed the same
ordering with COM hit harder, since a lone point has no redundancy against noise).

Box-and-whisker per (dataset x input) over SESSIONS: one observation is one
session's whole-session cross-view IDF1 (median line + IQR box, whiskers
1.5xIQR; n = 6/6/29). EVERY session is also drawn as a faint dot beside its
box -- not just the fliers -- so a dot means the same thing here as in panels
c/d/f/g (one session), instead of the boxplot-default "outliers only", which
read as a third encoding (2026-08-16 review). Keypoint boxes filled in the
dataset hue; COM boxes white with the dataset-hue edge. A box on a truncated
axis is fine where a bar was not: nothing here encodes length from zero.

INPUT PROVENANCE DIFFERS BY DATASET AND THE PANEL SAYS SO ON ITS FACE, because
the two arms must share ground-truth provenance:
  Both arms now take their 3D from SDANNCE's com3d_used (cells C4u_*), so the
  identity indices being scored come from the SAME tracker in both. The earlier
  COM arm (C4_com_*) drew TRIADS/SCN2A centroids from the deposit's COM-NETWORK
  outputs, whose indices come from the COM tracker itself, so the apparent
  COM deficit was measuring two ground truths disagreeing rather than anything
  about centroid input. BEDDING already used com3d_used, and C4u reproduces its
  C4 values bit-identically on all 6 sessions, which is the check on the switch.

Source: figs/fig10-bench/results/agg/summary.csv, cells C1_sigma0 vs
C4u_comused_sigma0.
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import use, panel, save, text_legend, DATASET_COLORS, MUTED, INK

use()

AGG = Path(__file__).resolve().parent.parent / "fig10-bench" / "results" / "agg"
FAM = {"triads": "TRIADS", "bedding": "BEDDING", "soc1": "SCN2A", "soc3": "SCN2A"}
COLOR = DATASET_COLORS

vals = defaultdict(list)
for r in csv.DictReader(open(AGG / "summary.csv")):
    if r["cell"] in ("C1_sigma0", "C4u_comused_sigma0"):
        vals[(FAM[r["dataset"]], r["cell"])].append(float(r["idf1"]))

FAMS = ["TRIADS", "BEDDING", "SCN2A"]
fig, ax = panel("third", "std", key=2)
rng = np.random.default_rng(0)
OFF = {"C1_sigma0": -0.20, "C4u_comused_sigma0": +0.20}
for gi, fam in enumerate(FAMS):
    for cell, off in OFF.items():
        v = vals[(fam, cell)]
        com = cell == "C4u_comused_sigma0"
        # A group pinned at 1.0 has a degenerate box; a white median would erase
        # it. Use white only when there is a visible box to sit on.
        q1, q3 = np.percentile(v, [25, 75])
        med_color = "white" if (not com and q3 - q1 > 0.01) else COLOR[fam]
        bp = ax.boxplot([v], positions=[gi + off], widths=0.32,
                        patch_artist=True, showfliers=False,
                        medianprops=dict(color=med_color, linewidth=2.2),
                        boxprops=dict(facecolor="white" if com else COLOR[fam],
                                      edgecolor=COLOR[fam], linewidth=1.0),
                        whiskerprops=dict(color=COLOR[fam], linewidth=1.0),
                        capprops=dict(color=COLOR[fam], linewidth=1.0))
        ax.scatter(np.full(len(v), gi + off) + rng.uniform(-0.055, 0.055, len(v)),
                   v, s=5, color=COLOR[fam], alpha=0.4, linewidths=0, zorder=3)
ax.set_xticks(range(len(FAMS)))
ax.set_xticklabels(FAMS)
ax.set_xlim(-0.6, len(FAMS) - 0.4)
ax.set_ylabel("cross-view IDF1 (σ = 0)")
ax.set_ylim(0.45, 1.02)
text_legend(ax, [("filled: keypoints (23 nodes)", INK),
                 ("open: COM only", MUTED)], loc="above")
ax.annotate("both arms:\ncom3d_used GT", (1 + OFF["C4u_comused_sigma0"], 0.95),
            textcoords="offset points", xytext=(0, -6), ha="center",
            va="top", fontsize=6, color=MUTED)
save(fig, 10, "e", "inputs")
