#!/usr/bin/env python3
"""
Fig 10c -- cross-view IDF1 against injected 2D pixel noise, per dataset family.

WHAT THE X AXIS IS. The 2D input is synthesized by reprojecting sDANNCE's own
3D through the deposit's calibration, so at sigma = 0 the six views agree
perfectly BY CONSTRUCTION -- that cell is the harness ceiling, not a result,
and the axis exists precisely because of that (PLAN-fig10 §2). Sigma is iid
Gaussian pixel noise added per keypoint per view; identity slots are shuffled
per (frame, view) in every cell.

MEDIANS + EVERY SESSION AS A POINT, not means: three sessions carry a persistent
identity swap seeded where the SOURCE tracks pass within a few mm of each other
(10f is that story), and a mean would smear that tail into the curve. The
median says what a typical session does (IDF1 = 1.0 through sigma = 5 on every
dataset); the points say the tail exists and where.

SOC1 + SOC3 are pooled as "SCN2A": same cohort, same rig, same dyad protocol,
two round-robin rounds (n = 14 + 15); their medians are indistinguishable.

Series: src.style.DATASET_COLORS -- TRIADS sky / BEDDING violet / SCN2A amber,
fixed across 10c-10g and Fig 11. The families used to wear teal/salmon/
periwinkle, which are the set-wide ENTITY hues (LUC3D/comparator/SLEAP); Fig 11
put both meanings on one page, so the datasets moved to the three non-entity
hues (adversarial review 2026-08-17).

Source: figs/fig10-bench/results/agg/summary.csv (fig10_aggregate.py); tracker =
shipped eric/switch-correct config, untuned (sync, stale 20, distThresh 25).
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import use, panel, save, text_legend, DATASET_COLORS

use()

AGG = Path(__file__).resolve().parent.parent / "fig10-bench" / "results" / "agg"
SIGMAS = [0, 1, 2, 3, 5, 10, 20]
FAM = {"triads": "TRIADS", "bedding": "BEDDING", "soc1": "SCN2A", "soc3": "SCN2A"}
COLOR = DATASET_COLORS
MARKER = {"TRIADS": "o", "BEDDING": "s", "SCN2A": "^"}

vals = defaultdict(list)                     # (family, sigma) -> [idf1 per session]
wnum = defaultdict(float)
wden = defaultdict(float)
for r in csv.DictReader(open(AGG / "summary.csv")):
    if r["cell"].startswith("C1_sigma"):
        s = int(r["cell"][len("C1_sigma"):])
        k = (FAM[r["dataset"]], s)
        vals[k].append(float(r["idf1"]))
        w = int(r["n_gt_dets"])
        wnum[k] += float(r["idf1"]) * w
        wden[k] += w

fig, ax = panel("third", "std", key=3)
rng = np.random.default_rng(0)
for fam in ["TRIADS", "BEDDING", "SCN2A"]:
    med = [wnum[(fam, s)] / wden[(fam, s)] for s in SIGMAS]
    xs = np.arange(len(SIGMAS))
    ax.plot(xs, med, color=COLOR[fam], marker=MARKER[fam], markersize=4,
            linewidth=2.0, zorder=3)
    for i, s in enumerate(SIGMAS):
        v = vals[(fam, s)]
        ax.scatter(np.full(len(v), i) + rng.uniform(-0.13, 0.13, len(v)), v,
                   s=5, color=COLOR[fam], alpha=0.35, linewidths=0, zorder=2)
ax.set_xticks(range(len(SIGMAS)))
ax.set_xticklabels([str(s) for s in SIGMAS])
# "(nonlinear)" declared IN the label, the same way fig3d's x axis declares its
# "(log)": the sampled sigmas 0..20 sit at EQUAL pitch, so the axis is not to
# scale and has to say so on its face (adversarial review 2026-08-17).
ax.set_xlabel("2D noise σ (px, nonlinear)")
ax.set_ylabel("cross-view IDF1")
ax.set_ylim(0.45, 1.02)
ax.axhline(1.0, color="#DDDDDD", linewidth=0.8, zorder=1)
text_legend(ax, [("TRIADS (3 rats, n=6)", COLOR["TRIADS"]),
                 ("BEDDING (2 rats, n=6)", COLOR["BEDDING"]),
                 ("SCN2A (2 rats, n=29)", COLOR["SCN2A"])], loc="above")
save(fig, 10, "c", "noise")
