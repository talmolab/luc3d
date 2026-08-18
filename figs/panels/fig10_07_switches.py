#!/usr/bin/env python3
"""
Fig 10g -- identity SWITCHES along the two difficulty axes that matter, in the
unit Fig 8 reports (switches per 100k camera-frames), so the two figures are
directly comparable: the same tracker on real Mouse-Dyad-10M detections runs at 0.92
sw/100k (FIG8-FINAL-50, sync_stale20_dist25).

WHAT COUNTS AS A SWITCH here: per GT animal, the majority identity across the
six views is taken per frame; a switch is that majority changing between
consecutive observed frames (fig10_score.py). A full swap of a dyad therefore
counts twice (both animals' timelines flip at the same frame) -- stated in the
legend so the sigma = 0 numbers ("5 swap events, 10 counted switches") read
right.

WHY THIS PANEL EARNS ITS PLACE next to 10c/10d: IDF1 is dominated by how LONG a
wrong stretch lasts, so one early swap costs 0.35 IDF1 while fifty brief
flickers cost almost nothing -- the two metrics fail differently, and a
proofreader cares about the COUNT (each switch is one moment to review). At
sigma = 0 the count is the finding: 36/41 sessions run 60-90k frames with ZERO
switches; the five exceptions carry one swap event each (10f). Corruption
raises the rate smoothly -- at sigma = 20 the pooled rates are 1.5-6.6 sw/100k
camera-frames, the same order as the tracker's rate on real detections.

Symlog y (linear below 1) because most cells sit at exactly 0 -- a log axis
would hide the zeros that ARE the result; the axis is labeled at 0/1/3/10/30.

THE LINE IS THE POOLED RATE (total switches / total camera-frames per
dataset), NOT the per-session median. Switch counts are majority-zero with a
heavy tail (at sigma <= 5 MOST sessions have exactly zero), so a median line
sits at 0 no matter what the tail does -- and the Fig 8 reference on this panel
IS a pooled rate, so a median was not comparable to it (2026-08-16 review:
"why does it appear to have 0 switches?"). Pooling cannot hide the tail; the
dots stay one per session.

Source: figs/fig10-bench/results/agg/summary.csv (`switches`, `frames` columns;
rate = switches / (frames x 6 cams) x 1e5).
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

rate = defaultdict(list)                     # (family, cell) -> [sw per 100k cam-frames]
tot_sw = defaultdict(int)
tot_cf = defaultdict(int)
for r in csv.DictReader(open(AGG / "summary.csv")):
    k = (FAM[r["dataset"]], r["cell"])
    v = 1e5 * int(r["switches"]) / (int(r["frames"]) * 6)
    rate[k].append(v)
    tot_sw[k] += int(r["switches"])
    tot_cf[k] += int(r["frames"]) * 6


def pooled(fam, cell):
    k = (fam, cell)
    return 1e5 * tot_sw[k] / tot_cf[k]

SIGMAS = [0, 1, 2, 3, 5, 10, 20]
# dropout arm at sigma = 0 (Eric 2026-08-16); 25% = the C7d full-rig cell
DROPS = [(0.0, "C1_sigma0"), (0.25, "C7d_cams6_drop25"), (0.5, "C8_drop50_sigma0")]

fig, axes = grid(1, 2, span="two-thirds", row="std", sharey=True)
fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 3 + 0.02)))
rng = np.random.default_rng(0)

ax = axes[0]
for fam in ["TRIADS", "BEDDING", "SCN2A"]:
    med = [pooled(fam, f"C1_sigma{s}") for s in SIGMAS]
    xs = np.arange(len(SIGMAS))
    ax.plot(xs, med, color=COLOR[fam], marker=MARKER[fam], markersize=4,
            linewidth=2.0, zorder=3)
    for i, s in enumerate(SIGMAS):
        v = rate[(fam, f"C1_sigma{s}")]
        ax.scatter(np.full(len(v), i) + rng.uniform(-0.13, 0.13, len(v)), v,
                   s=5, color=COLOR[fam], alpha=0.35, linewidths=0, zorder=2)
ax.set_xticks(range(len(SIGMAS)))
ax.set_xticklabels([str(s) for s in SIGMAS])
# "(nonlinear)" declared in the label, fig3d's "(log)" idiom: the sampled sigmas
# sit at equal pitch, so the axis is not to scale (adversarial review 2026-08-17).
ax.set_xlabel("2D noise σ (px, nonlinear)")
ax.set_ylabel("switches / 100k camera-frames")
ax.annotate("36/41 sessions: 0 switches", (0.02, 0.30), xycoords="axes fraction",
            fontsize=6.5, color=MUTED)

ax = axes[1]
for fam in ["TRIADS", "BEDDING", "SCN2A"]:
    med = [pooled(fam, c) for _, c in DROPS]
    xs = np.arange(len(DROPS))
    ax.plot(xs, med, color=COLOR[fam], marker=MARKER[fam], markersize=4,
            linewidth=2.0, zorder=3)
    for i, (_, c) in enumerate(DROPS):
        v = rate[(fam, c)]
        ax.scatter(np.full(len(v), i) + rng.uniform(-0.13, 0.13, len(v)), v,
                   s=5, color=COLOR[fam], alpha=0.35, linewidths=0, zorder=2)
ax.set_xticks(range(len(DROPS)))
ax.set_xticklabels([f"{int(p * 100)}" for p, _ in DROPS])
ax.set_xlabel("instance dropout (%), σ = 0")

for a in axes:
    a.set_yscale("symlog", linthresh=1.0)
    a.set_ylim(-0.05, 40)
    a.set_yticks([0, 1, 3, 10, 30])
    a.set_yticklabels(["0", "1", "3", "10", "30"])
    # Fig 8 reference: the same tracker's rate on real Mouse-Dyad-10M detections.
    a.axhline(0.92, color="#BBBBBB", linewidth=0.8, linestyle=(0, (3, 2)), zorder=1)
axes[0].text(0.02, 1.15, "real detections (Fig 8): 0.92",
             fontsize=6, color=MUTED, ha="left", va="bottom")
text_legend(axes[0], [("TRIADS", COLOR["TRIADS"]), ("BEDDING", COLOR["BEDDING"]),
                      ("SCN2A", COLOR["SCN2A"])], loc="above")
save(fig, 10, "g", "switches")
