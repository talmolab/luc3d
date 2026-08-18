#!/usr/bin/env python3
"""
Fig 10b -- calibration/ground-truth anchor: reprojection residuals against the
RAW human clicks, per camera, pooled over all six TRIADS sessions.

TWO NUMBERS ARE IN PLAY AND THE PANEL MUST NOT CONFLATE THEM. Against Label3D's
own stored `data_2d` our projection is exact to ~1e-13 px on every camera of
all 41 sessions (figs/fig10-bench/validate_*.json) -- but that only proves our
MATLAB-convention conversion equals Label3D's, because `data_2d` IS Label3D's
reprojection of the triangulated label. The independent anchor is
`handLabeled2D`: the labeler's raw clicks, stored before triangulation, which
only TRIADS deposits. The residual drawn here -- reprojected 3D COM label vs
raw click -- is therefore (click noise + triangulation residual), an UPPER
bound on the calibration error, and its 4-6 px per-camera median on a ~2268 px
focal length is the figure's license to synthesize 2D from 3D at all.

BEDDING/SCN2A are not drawn: their deposits store only the reprojected 2D
(residual 0 by construction -- stated in the caption, not plotted, because a
zero bar would be theater).

Form: one box per camera (medians + IQR whiskers, house box style), n printed
under each. Single quantity, no series colors -- boxes in INK.

Source: figs/fig10-bench/results/agg/panel_10b_residuals.json, written by
figs/fig10-bench/fig10_paneldata.py.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import use, panel, save, INK, MUTED, TEAL

use()

AGG = Path(__file__).resolve().parent.parent / "fig10-bench" / "results" / "agg"
res = json.load(open(AGG / "panel_10b_residuals.json"))
cams = sorted(res, key=int)
data = [np.asarray(res[c]) for c in cams]

fig, ax = panel("third", "std")
bp = ax.boxplot(data, positions=range(1, 7), widths=0.55, showfliers=False,
                medianprops=dict(color=TEAL, linewidth=2.0),
                boxprops=dict(color=INK), whiskerprops=dict(color=INK),
                capprops=dict(color=INK))
ax.set_xticks(range(1, 7))
ax.set_xticklabels(cams)
ns = [len(d) for d in data]
ax.set_xlabel(f"camera  (n = {min(ns)}–{max(ns)} clicks each)")
ax.set_ylabel("reprojection vs raw click (px)")
ax.set_ylim(0, None)
med = float(np.median(np.concatenate(data)))
ax.text(0.98, 0.95, f"pooled median {med:.1f} px",
        transform=ax.transAxes, ha="right", va="top", color=TEAL,
        fontweight="bold")
save(fig, 10, "b", "residuals")
