#!/usr/bin/env python3
"""
Fig 7g -- recovered against KNOWN cameras, on a synthetic rig.

THE ONLY PANEL THAT ASKS "DID IT RECOVER THE CAMERA" rather than "did it fit the
corners", and it exists because every other panel is scored on reprojection error --
the quantity the solver itself minimises. Two objections follow from that and neither
can be settled on real data:

  1. A richer intrinsic model can lower reprojection error by ABSORBING board
     non-planarity and detector bias as if they were lens distortion. That is a worse
     description of the camera which scores better.
  2. Reprojection error is blind to a global SCALE error. A rig reconstructed 3 % too
     large reprojects perfectly; every point is consistent, the rig is just the wrong
     size. Nothing in panels a-d can see it.

The synthetic session settles both: the board is exactly planar (so there is no board
error to absorb) and the true intrinsics and poses are known. Its ground truth is built
to contain precisely what aniposelib's model cannot express -- a principal point a median
19.7 px off the image centre, fy != fx by up to 7 %, and k2 = 0.05.

WHAT IS AND IS NOT INFORMATIVE HERE. Δcx,cy and Δk2 for Anipose mostly recover the values
it PINS, so they are near-tautological and are drawn pale. The load-bearing bars are the
ones both tools estimate freely: the focal length, and the two 3D quantities -- camera
centre after a similarity fit, and the scale error.

A LOG AXIS WITH TWO UNITS ON IT would be dishonest, so the panel is split: the left group
is dimensionless (%), the right is what it costs in 3D.

    python3 figs/panels/fig7_05_ground_truth.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fig7_common import ARM_COLOR  # noqa: E402
from matplotlib.colors import to_rgba  # noqa: E402
from src.data_loader import load  # noqa: E402
from src.style import MUTED, deposit, panel, save, text_legend, use  # noqa: E402

PANELS = [("g", "ground_truth")]

#: (deposit key, printed label, is it a parameter the arm FITS FREELY?). The pinned ones
#: are drawn pale: reporting that a pinned parameter is wrong by its pinned amount is
#: true but uninformative, and at full saturation it would dominate the panel.
#: THE THREE PARAMETERS BOTH MODELS FIT FREELY, all as a per-cent so one log axis
#: carries one unit. The pinned ones (principal point, k2) are deliberately NOT drawn:
#: reporting that a pinned parameter is wrong by exactly its pinned amount is true and
#: uninformative, and it would be the tallest bar on the panel. They are in the CSV and
#: the legend quotes them. Camera-centre error is expressed against the median true
#: camera-pair distance, so "how far off is the rig" is comparable with "how wrong is
#: the focal length"; the absolute millimetres are deposited beside it.
METRICS = [("d_fx", "focal\nlength", True),
           ("centre_pct", "camera\ncentre", True),
           ("scale_pct", "rig\nscale", True)]
ARMS = [("calibrat3", "calibrat3"), ("anipose", "Anipose")]
OFFSET = {"calibrat3": -0.19, "anipose": 0.19}


def main():
    use()
    rec = load("fig7_calibration.json")
    syn = rec.get("synthetic")
    if not syn:
        raise SystemExit("fig7_calibration.json has no `synthetic` block; run "
                         "figs/fig7_calib_deposit_extra.py")

    fig, ax = panel("quarter", "std", key=2)
    rows = []
    for arm, aname in ARMS:
        a = syn["arms"].get(arm)
        if a is None:
            raise SystemExit(f"synthetic block has no arm {arm!r}")
        for i, (key, label, free) in enumerate(METRICS):
            v = abs(a[key])
            color = ARM_COLOR[arm]
            ax.bar(i + OFFSET[arm], max(v, 1e-3), 0.34,
                   color=to_rgba(color, 0.9 if free else 0.30),
                   edgecolor=color, lw=0.7, zorder=2)
            rows.append({"arm": arm, "metric": key, "label": label.replace("\n", " "),
                         "value": v, "freely_fitted": free})
    ax.set_yscale("log")
    ax.set_ylim(1e-2, 30)
    ax.set_xticks(range(len(METRICS)))
    ax.set_xticklabels([m[1] for m in METRICS], fontsize=6.5)
    ax.tick_params(axis="x", length=0, pad=2.0)
    ax.set_ylabel("error vs ground truth (%)")
    ax.axvline(0.5, color=MUTED, lw=0.6, ls=(0, (2, 2)), zorder=1)
    text_legend(ax, [(n, ARM_COLOR[k]) for k, n in ARMS], loc="above", size=6.5, dy=0.05)
    deposit(pd.DataFrame(rows), 7, "fig7g_ground_truth.csv")
    save(fig, 7, "g", "ground_truth")


if __name__ == "__main__":
    main()
