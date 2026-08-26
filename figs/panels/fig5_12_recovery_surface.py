#!/usr/bin/env python3
"""
Fig 6c -- keypoints missing after reprojection recovery: difficulty x cameras.

PLACED AS 6c ON INSTRUCTION (Eric, 2026-08-15: "6c should be the plot you made which
is # of cameras x difficulty x missing keypoints" -- it visited 4c for twenty minutes
on a crossed wire; 4c is the all-cameras-vs-drop-worst comparison). The old 6c
(three-sub-plot detection quality) moved to the supplementary letter fig6 s6. Fig 6
is SLAP-2M throughout, so no corpus label is needed here.

The review's F6.1 surface, to Eric's spec (2026-08-15): "keypoints missing on z,
difficulty rating on x, and # of cameras on y ... how many points are recovered by
the number of cameras included". z is the RESIDUAL miss rate -- the share of
GT keypoints a k-camera rig still lacks after every keypoint detected in >= 2 other
cameras of that rig is triangulated and reprojected back in. k = 2 is the honest
floor: with one other view nothing can be triangulated, so recovery is zero BY
CONSTRUCTION and the k = 2 row equals the raw detector miss rate.

DEFAULT IS THE HEAT-MAP (the plane seen from above, every cell readable at print
size); `--surface` renders the literal 3D plane. Both from the same deposit; the
choice is presentation only.

Exact, not sampled: each cell is a closed-form expectation over ALL C(6,k) camera
subsets, computed from per-session (GT-views, detected-views) histograms matched by
Fig 6c's own convention at stride 1 (figs/fig5_recovery.py).

Source: figs/out/fig6_recovery.json.

    python3 figs/panels/fig6_12_recovery_surface.py            # heat-map
    python3 figs/panels/fig6_12_recovery_surface.py --surface  # 3D plane
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, MUTED, deposit, panel, save, use  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig5_recovery import surface_from_hist  # noqa: E402

KS = (2, 3, 4, 5, 6)


def build():
    j = load("fig6_recovery.json")
    by_diff = defaultdict(lambda: np.zeros((7, 7), dtype=np.int64))
    for sid, h in j["histograms"].items():
        d = j["difficulty"].get(sid)
        if d is None:
            continue
        by_diff[int(d)] += np.array(h["hist"], dtype=np.int64)
    rows = []
    for d in sorted(by_diff):
        surf = surface_from_hist(by_diff[d], ks=KS)
        for k in KS:
            rows.append({"difficulty": d, "cameras": k,
                         "residual_missing_pct": surf[k]["residual_missing_pct"],
                         "recovered_pct_of_missing":
                             surf[k]["recovered_pct_of_missing"],
                         "raw_miss_pct": surf[2]["miss_per_view_pct"]})
    return pd.DataFrame(rows)


def main(surface=False):
    use()
    df = build()
    deposit(df, 5, "fig5c_recovery_surface.csv")
    diffs = sorted(df.difficulty.unique())
    Z = np.array([[df[(df.difficulty == d) & (df.cameras == k)]
                   .residual_missing_pct.iloc[0] for d in diffs] for k in KS])

    if not surface:
        fig, ax = panel("half", "std")
        im = ax.imshow(Z, aspect="auto", origin="lower", cmap="viridis_r",
                       extent=[diffs[0] - 0.5, diffs[-1] + 0.5,
                               KS[0] - 0.5, KS[-1] + 0.5])
        # Every cell carries its value: a colour bar makes a reader interpolate a
        # ramp; sixty printed numbers do not. Ink flips against the ramp.
        vmid = (Z.max() + Z.min()) / 2
        for i, k in enumerate(KS):
            for jx, d in enumerate(diffs):
                ax.text(d, k, f"{Z[i, jx]:.0f}", ha="center", va="center",
                        fontsize=6, color="white" if Z[i, jx] > vmid else INK)
        ax.set_xticks(diffs)
        ax.set_yticks(list(KS))
        ax.set_xlabel("difficulty rating")
        ax.set_ylabel("cameras in the rig")
        ax.set_title("")
        cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
        cb.set_label("keypoints still missing (%)", fontsize=7)
        cb.ax.tick_params(labelsize=6.5)
        save(fig, 5, "c", "recovery_surface")
    else:
        import matplotlib.pyplot as plt
        fig = plt.figure(figsize=(3.46, 2.8))
        ax = fig.add_subplot(111, projection="3d")
        Dm, Km = np.meshgrid(diffs, KS)
        ax.plot_surface(Dm, Km, Z, cmap="viridis_r", edgecolor=INK,
                        linewidth=0.3, alpha=0.95)
        ax.set_xlabel("difficulty", fontsize=7, labelpad=-4)
        ax.set_ylabel("cameras", fontsize=7, labelpad=-4)
        ax.set_zlabel("missing (%)", fontsize=7, labelpad=-4)
        ax.tick_params(labelsize=6, pad=-2)
        ax.view_init(elev=22, azim=-135)
        save(fig, 5, "c", "recovery_surface_3d")


if __name__ == "__main__":
    main(surface="--surface" in sys.argv)
