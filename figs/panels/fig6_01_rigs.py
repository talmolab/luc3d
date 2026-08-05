#!/usr/bin/env python3
"""
Fig 6 supplementary -- the two camera rigs, from their real calibration extrinsics.

NOT the main-figure 6a, which is the app's own 3D rig render (fig6-rig.png). This
plan view is kept because it is the only place the two rigs are drawn to the same
scale from the calibration itself.

Camera centres are recovered as C = -R^T t from each corpus's calibration, and the
optical axis is the third row of R. So this is the geometry the reconstructions were
actually computed in, not a sketch of it.

Plotted in plan view (x-y) with each camera's optical axis as a short spur, because
what distinguishes these two rigs is the AZIMUTHAL spread -- BMimica's 5 cameras
against SLAP-2M's 8 -- and that is what conditions a two-view solve (Fig 2d).

MIND THE Z SIGN. This rig's calibration frame has +Z pointing DOWN: the overhead
cameras have a SMALLER z than the animals on the floor. Anything that assumes Z-up
renders the rig inverted, which is how the first pass of Fig 1c came out. Plan view
sidesteps it, but do not "fix" the sign if you extend this to an elevation.

Source: figs/out/fig6.json `rigs`.

    python3 figs/panels/fig6_01_rigs.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import MUTED, grid, GREY, INK, SET2, deposit, save, use  # noqa: E402


def centres(rig: dict):
    """(name, centre, optical axis) per camera.

    `fig6_measure.py` deposits both directly: `pos` is the camera centre
    (-R^T t, already recovered from the extrinsics) and `axis` is the optical axis
    (the third row of R). Both are used as given -- there is nothing to re-derive.
    """
    out = []
    for name, cam in rig.items():
        if not (isinstance(cam, dict) and "pos" in cam):
            continue
        out.append((name, np.asarray(cam["pos"], float),
                    np.asarray(cam.get("axis", [0, 0, 1]), float)))
    return out


def main():
    use()
    rigs = load("fig6.json")["rigs"]

    rows = []
    fig, axes = grid(1, len(rigs), span="half", row="std", despine=False)
    axes = np.atleast_1d(axes)
    for k, (corpus, rig) in enumerate(rigs.items()):
        ax = axes[k]
        cams = centres(rig)
        if not cams:
            ax.text(0.5, 0.5, f"{corpus}\n(no extrinsics in fig6.json)",
                    transform=ax.transAxes, ha="center", va="center", color=MUTED,
                    fontsize=7)
            ax.set_axis_off()
            continue

        P = np.array([C for _, C, _ in cams])
        mid = P[:, :2].mean(axis=0)
        for i, (name, C, a) in enumerate(cams):
            ax.plot([C[0]], [C[1]], "o", color=SET2[i % len(SET2)], ms=6,
                    mec="white", mew=1.0, zorder=4)
            # The REAL optical axis, projected into plan view. A near-vertical
            # camera projects to a short spur, which is correct and informative:
            # it says the camera looks straight down.
            span = 0.20 * np.ptp(P[:, :2])
            ax.plot([C[0], C[0] + a[0] * span], [C[1], C[1] + a[1] * span],
                    color=SET2[i % len(SET2)], lw=1.0, zorder=3)
            rows.append({"corpus": corpus, "camera": name,
                         "x": C[0], "y": C[1], "z": C[2],
                         "axis_x": a[0], "axis_y": a[1], "axis_z": a[2]})

        ax.plot([mid[0]], [mid[1]], "x", color=INK, ms=5, mew=1.0, zorder=5)
        ax.set_aspect("equal")
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        ax.set_xlabel(f"{corpus}\n{len(cams)} cameras", color=INK, fontsize=7.5)

    if rows:
        deposit(pd.DataFrame(rows), 6, "fig6a_rigs.csv")
    fig.subplots_adjust(wspace=0.08)
    save(fig, 6, "s1", "rig_extrinsics")


if __name__ == "__main__":
    main()
