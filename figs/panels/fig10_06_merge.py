#!/usr/bin/env python3
"""
Fig 10f -- where the sigma = 0 losses come from: every session's noiseless IDF1
against how close that session's SOURCE tracks ever get to each other.

THE MECHANISM, established per-session by figs/fig10-bench/fig10_swapdiag.py:
each low session loses its IDF1 through ONE persistent swap, and the swap frame
sits within ~25 frames of the session's closest source-track approach. When
sDANNCE's own 3D tracks pass within a few millimetres, the two animals'
keypoint clouds coincide in every camera at once; whichever assignment the
tracker exits the merge with is then locked in by design (identity is meant to
persist), so the merge is a coin flip it cannot see. The scatter shows both
outcomes exist: sub-6 mm sessions at IDF1 = 1.0 (it won the flip, or anchors
carried through a short merge) AND the swapped tail (TRIADS M12_M13_M14 at
0.79 after a 3.0 mm approach; SCN2A M5_M4 at 0.65 after 5.9 mm).

The one exception is drawn as its own annotation: BEDDING F6_F2 swaps once at a
~45 mm closest approach (bodies overlapping, COMs apart) early in the session,
costing 3% -- a genuine close-interaction miss, not a merge.

WHY THIS IS THE RIGHT CAVEAT PANEL. "GT identity" here is sDANNCE's own output
(PLAN-fig10 §2); at a sub-6 mm merge, THEIR identity through the merge is
exactly as undecidable as ours. The panel turns the caveat into a measurement:
identity on this corpus is well-posed except at track merges, and merges are
visible in the source data itself.

x is log-scale (0.1-300 mm); the shaded band marks < 6 mm, the region where a
merge was observed to seed a swap. One point per session, dataset hues of
10c-e.

Source: figs/fig10-bench/results/agg/panel_10f_merge.json (fig10_paneldata.py).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import use, panel, save, text_legend, DATASET_COLORS, MUTED

use()

AGG = Path(__file__).resolve().parent.parent / "fig10-bench" / "results" / "agg"
rows = json.load(open(AGG / "panel_10f_merge.json"))
FAM = {"triads": "TRIADS", "bedding": "BEDDING", "soc1": "SCN2A", "soc3": "SCN2A"}
COLOR = DATASET_COLORS
MARKER = {"TRIADS": "o", "BEDDING": "s", "SCN2A": "^"}

fig, ax = panel("half", "std", key=3)
ax.axvspan(0.1, 6, color="#EEEEEE", zorder=0)
ax.text(0.8, 0.475, "source tracks\ncoincide", fontsize=6.5, color=MUTED,
        ha="left", va="bottom")
for r in rows:
    fam = FAM[r["dataset"]]
    ax.scatter(max(r["min_pair_mm"], 0.12), r["idf1_sigma0"],
               s=18, color=COLOR[fam], marker=MARKER[fam], alpha=0.85,
               linewidths=0, zorder=3)
ax.set_xscale("log")
ax.set_xlim(0.1, 400)
ax.set_ylim(0.45, 1.03)
ax.set_xlabel("closest source-track approach in session (mm)")
ax.set_ylabel("cross-view IDF1 at σ = 0")

# the three named tails
for r in rows:
    if r["idf1_sigma0"] < 0.98:
        label = {"2023_03_01_M12_M13_M14": "M12_M13_M14",
                 "2022_09_23_M5_M4": "M5_M4",
                 "2024_05_07_F6_F2": "F6_F2"}.get(r["session"])
        if label:
            # (6, -7), not (6, -2): at -2 the F6_F2 label's box clipped its own
            # marker (lint: ON DATA, 16% inked); a step lower it hangs clear
            # under all three named points.
            ax.annotate(label, (max(r["min_pair_mm"], 0.12), r["idf1_sigma0"]),
                        textcoords="offset points", xytext=(6, -7),
                        fontsize=6.5, color=MUTED)
text_legend(ax, [("TRIADS", COLOR["TRIADS"]), ("BEDDING", COLOR["BEDDING"]),
                 ("SCN2A", COLOR["SCN2A"])], loc="above")
save(fig, 10, "f", "merge")
