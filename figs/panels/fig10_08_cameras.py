#!/usr/bin/env python3
"""
Fig 10f -- how many cameras does identity need? Switch rate against the number
of cameras used, at sigma = 3 px with 0% dropout (left: the working-noise
floor per camera count) and under 25% instance dropout at sigma = 0 (right:
missingness alone) -- conditions settled by Eric 2026-08-16. Between them the
arms separate the two failure sources: pixel noise barely engages camera
count; missing detections are what camera redundancy exists to absorb.

CAMERA SUBSETS are fixed, maximally spread selections on the measured rig ring
(azimuths put the six cameras ~60 degrees apart in the order 4,6,3,1,2,5):
k=2 is an opposite pair {1,4}; k=3 every-other {2,3,4}; k=4 drops an opposite
pair {1,3,4,5}; k=5 drops one camera; k=6 is the full rig (the C1 cells,
not re-run). Same prep'd detections, the tracker simply reads fewer views.

WHY SWITCHES AND NOT IDF1 ON THE AXIS: median IDF1 is 1.0 at EVERY camera
count at sigma = 3 -- even an opposite PAIR of cameras carries the typical
session -- and a panel of flat lines at 1.0 says nothing. The sensitive metric
is the switch rate, and it falls monotonically as views are added: redundancy
buys error RATE, not typical-case success. sigma = 3 medians are all zero
(only the tail moves); missing detections are where camera count visibly
matters.

UNIT: switches per 100k FRAMES (session time), not per camera-frame as in 10g
-- a switch is a temporal event, and dividing by camera count would
mechanically penalize the small-k cells this panel exists to compare. The two
panels' units are labeled and must not be cross-read.

THE LINE IS THE POOLED RATE (total switches / total frames per dataset), not
the per-session median -- switch counts are majority-zero with a heavy tail, so
a median line reads 0 regardless of the tail (2026-08-16 review). The pooled
SCN2A line stays ~20-25/100k across camera counts because a few hard sessions
dominate it; the TYPICAL SCN2A session is at zero from 4 cameras up -- the
legend carries both statements. Dots: one per session; symlog y (zeros are real
and must be visible).

Source: figs/fig10-bench/results/agg/summary.csv, cells C7_cams{2..5} /
C7b_cams{2..5}_sigma10 / C1_sigma{3,10}.
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

# Final conditions (Eric 2026-08-16, settled): LEFT = 0% dropout at
# sigma = 3 px (C7 cells) — the working-noise floor per camera count;
# RIGHT = 25% instance dropout at sigma = 0 (C7d cells) — missingness alone.
# Every other measured arm (sigma0 clean C7c, sigma10 C7b, sigma3+drop25 C7e,
# sigma3+drop10 C7f) remains in summary.csv for later re-cuts.
CELLS = {
    "0% dropout · σ = 3 px": {2: "C7_cams2", 3: "C7_cams3", 4: "C7_cams4",
                              5: "C7_cams5", 6: "C1_sigma3"},
    "25% dropout · σ = 0": {2: "C7d_cams2_drop25", 3: "C7d_cams3_drop25",
                            4: "C7d_cams4_drop25", 5: "C7d_cams5_drop25",
                            6: "C7d_cams6_drop25"},
}
KS = [2, 3, 4, 5, 6]

rate = defaultdict(list)                    # (family, cell) -> sw per 100k frames
tot_sw = defaultdict(int)
tot_f = defaultdict(int)
for r in csv.DictReader(open(AGG / "summary.csv")):
    k = (FAM[r["dataset"]], r["cell"])
    rate[k].append(1e5 * int(r["switches"]) / int(r["frames"]))
    tot_sw[k] += int(r["switches"])
    tot_f[k] += int(r["frames"])


def pooled(fam, cell):
    return 1e5 * tot_sw[(fam, cell)] / tot_f[(fam, cell)]

fig, axes = grid(1, 2, span="half", row="std", sharey=True)
fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * 3 + 0.02)))
rng = np.random.default_rng(0)
for ax, (title, cells) in zip(axes, CELLS.items()):
    for fam in ["TRIADS", "BEDDING", "SCN2A"]:
        med = [pooled(fam, cells[k]) for k in KS]
        xs = np.arange(len(KS))
        ax.plot(xs, med, color=COLOR[fam], marker=MARKER[fam], markersize=4,
                linewidth=2.0, zorder=3)
        for i, k in enumerate(KS):
            v = rate[(fam, cells[k])]
            ax.scatter(np.full(len(v), i) + rng.uniform(-0.13, 0.13, len(v)), v,
                       s=5, color=COLOR[fam], alpha=0.35, linewidths=0, zorder=2)
    ax.set_xticks(range(len(KS)))
    ax.set_xticklabels([str(k) for k in KS])
    ax.set_title(title, fontsize=8, color=MUTED)
    ax.set_yscale("symlog", linthresh=1.0)
    ax.set_ylim(-0.05, 1300)
    ax.set_yticks([0, 1, 3, 10, 30, 100, 300])
    ax.set_yticklabels(["0", "1", "3", "10", "30", "100", "300"])
axes[0].set_ylabel("switches / 100k frames")
axes[0].set_xlabel("cameras used")
axes[1].set_xlabel("cameras used")
text_legend(axes[0], [("TRIADS", COLOR["TRIADS"]), ("BEDDING", COLOR["BEDDING"]),
                      ("SCN2A", COLOR["SCN2A"])], loc="above")
save(fig, 10, "f", "cameras")
