#!/usr/bin/env python3
"""
Fig 4e -- solve time per keypoint, FOUR bars: each solver beside its counterpart.

WHY FOUR AND NOT THREE. The three-bar version put Anipose's *linear* solve next to
LUC3D's *non-linear* refinement and invited the reading "our refinement is 1.6x
slower than Anipose" -- a category error. A closed-form SVD and an iterative robust
solve are not the same amount of arithmetic, and the panel was comparing across that
line. The bars are now PAIRED BY ALGORITHM CLASS:

    linear      LUC3D DLT              6.3  <->  Anipose triangulate      28.0
    non-linear  LUC3D refinement      43.8  <->  Anipose optim_points    120.4

Read across a pair and the comparison is real: **we are 4.3x faster on the linear
solve and 2.9x faster on the non-linear one.** Read down a column and you get the
cost of refining within one library.

THE ORDER DELIBERATELY DIFFERS FROM PANEL d, which runs Anipose / DLT / refined. The
pairing IS this panel's argument, and it cannot be made while also matching d's
order. What holds the two panels together is COLOUR -- green is Anipose in both,
salmon our DLT, teal our refinement -- so a reader can still map a column across the
figure by hue. The Anipose optim bar is hatched to mark it as the second Anipose
configuration rather than a fourth method.

WHICH ANIPOSE CONFIGURATION EACH BAR IS. `anipose triangulate` reads two flags,
both `False` by default (verified in `anipose/anipose.py`):
    optim: false, ransac: false  ->  CameraGroup.triangulate        28.0  (bar 2)
    optim: true                  ->  CameraGroup.optim_points      120.4  (bar 4)
    ransac: true                 ->  CameraGroup.triangulate_ransac 2324  (caption)
The ransac path is 83x the default and would flatten every other bar, so it is
reported in the caption rather than drawn. Naming the config on the artwork matters
because "Anipose" spans two orders of magnitude depending on it.

THE OPTIM BAR IS NOT A PER-KEYPOINT CONSTANT, and the whisker says so.
`optim_points` is one global `scipy.least_squares` per session, so its cost per
keypoint falls as fixed costs amortise: 383 us/kp at 1,000 frames, then 112.8 and
120.4 at 2,000 and 4,000. The bar is the largest run and the whisker spans the
SESSION-SCALE sizes only (>= 2,000 frames); the 383 start-up point is in the caption,
not averaged into a number that would then describe neither regime.

The LUC3D bars come from the whole-corpus run (`fig4.json`, 4,253,636 keypoints);
the Anipose bars from `fig4_anipose.json`. To make that one comparison rather than
two machine loads, `fig4_anipose.py` re-times BOTH LUC3D solvers in its own sitting
and reports the disagreement -- 3% on DLT and 5% on the refinement here.

All bars are the SOLVE ONLY: undistortion is excluded from every one, because
`CameraGroup.triangulate` undistorts inside the call and LUC3D outside it, and
charging one and not the other would be an artefact of where each library draws a
function boundary. Excluded: 0.45 us Anipose, 1.14 us LUC3D.

Source: figs/out/fig4.json         `methods.{dlt,ba}.us_per_keypoint`
        figs/out/fig4_anipose.json `timing.{anipose,anipose_optim,anipose_ransac}`
                                   `per_session_optim` (deposited, caption evidence)

    python3 figs/panels/fig4_06_time_per_keypoint.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import MUTED, deposit, entity, panel, save, use  # noqa: E402

#: Frames below which `optim_points` is still paying start-up rather than a
#: session-scale cost. Set from the sweep itself: 1,000 frames measures 383 us/kp
#: against 113-120 at every larger size, i.e. the fixed cost has amortised by 2,000.
OPTIM_AMORTISED_FRAMES = 2000


def build() -> pd.DataFrame:
    m = load("fig4.json")["methods"]
    t = load("fig4_anipose.json")["timing"]
    a, o = t["anipose"], t["anipose_optim"]
    amort = [r["us_per_keypoint"] for r in o["sweep"]
             if r["n_frames"] >= OPTIM_AMORTISED_FRAMES]
    return pd.DataFrame([
        {"solver": "DLT", "label": "DLT", "who": "ours", "kind": "linear",
         "us_per_keypoint": m["dlt"]["us_per_keypoint"], "lo": None, "hi": None,
         "config": "LUC3D, closed form"},
        {"solver": "Anipose", "label": "Anipose", "who": "anipose", "kind": "linear",
         "us_per_keypoint": a["us_per_keypoint"], "lo": None, "hi": None,
         "config": "CameraGroup.triangulate (optim: false, ransac: false)"},
        {"solver": "refined", "label": "refined", "who": "ours", "kind": "non-linear",
         "us_per_keypoint": m["ba"]["us_per_keypoint"], "lo": None, "hi": None,
         "config": "LUC3D refinement, soft-L1 + L1 polish, DLT-seeded"},
        {"solver": "Anipose optim", "label": "Anipose\noptim", "who": "anipose",
         "kind": "non-linear", "us_per_keypoint": o["us_per_keypoint"],
         "lo": min(amort), "hi": max(amort),
         "config": "CameraGroup.optim_points (optim: true), n-dependent"},
    ])


def main():
    use()
    df = build()
    deposit(df.drop(columns=["label"]), 4, "fig4e_time_per_keypoint.csv")

    # THE ACCURACY OF THE OPTIM ARM IS DEPOSITED HERE TOO, though this panel plots
    # only time. It is the evidence for the caption's claim that Anipose's optimiser
    # buys almost nothing over its own DLT, and a claim in a caption needs a file
    # behind it. `optim` (aniposelib's defaults) carries temporal smoothing that our
    # stride-60 sampling makes meaningless -- `optim_nosmooth` is the like-for-like
    # arm. Panel d deliberately has no optim column for that reason.
    po = load("fig4_anipose.json").get("per_session_optim") or []
    if po:
        deposit(pd.DataFrame(po), 4, "fig4e_anipose_optim_accuracy.csv")

    # A THIRD, NOT A QUARTER. Four bars, two of them needing two-line labels
    # ("Anipose optim" does not fit on one), do not fit in 42 mm. The row is
    # (d two-thirds 117.3 + e third 57.3) = 178.6 mm, inside the 180 mm page.
    fig, ax = panel("third", "std")
    colors = [entity("dlt"), entity("anipose"), entity("refined"), entity("anipose")]
    x = np.arange(len(df))
    for i, r in df.iterrows():
        # HATCH THE SECOND ANIPOSE BAR. Same hue because it is the same library;
        # hatched because it is a different configuration of it, and a reader who
        # sees two solid green bars will count two methods.
        ax.bar(i, r.us_per_keypoint, width=0.66, color=colors[i], zorder=2,
               hatch="///" if r.solver == "Anipose optim" else None,
               edgecolor="white" if r.solver == "Anipose optim" else "none",
               linewidth=0)
    top = df.us_per_keypoint.max()
    hi = df.hi.max()
    for i, r in df.iterrows():
        if r.lo is not None and r.hi is not None and r.hi > r.lo:
            ax.plot([i, i], [r.lo, r.hi], color=MUTED, lw=0.8, zorder=3)
            for y in (r.lo, r.hi):
                ax.plot([i - 0.09, i + 0.09], [y, y], color=MUTED, lw=0.8, zorder=3)
        y = max(r.us_per_keypoint, r.hi if r.hi is not None else 0)
        ax.text(i, y + top * 0.025, f"{r.us_per_keypoint:.1f}", ha="center",
                va="bottom", fontweight="bold", color=colors[i])

    # THE TWO PAIRWISE RATIOS, which are the panel's whole point, drawn as brackets
    # over each pair rather than left to the reader's arithmetic.
    v = df.us_per_keypoint.values
    for (lo_i, hi_i), yf in (((0, 1), 1.20), ((2, 3), 1.20)):
        y = top * yf
        ax.annotate("", xy=(hi_i, y), xytext=(lo_i, y),
                    arrowprops=dict(arrowstyle="-", lw=0.7, color=MUTED))
        ax.text((lo_i + hi_i) / 2, y + top * 0.015,
                f"{v[hi_i] / v[lo_i]:.1f}× ours", ha="center", va="bottom",
                fontsize=6, fontweight="bold", color=MUTED)
    ax.set_ylim(0, top * 1.40)
    ax.set_xticks(x)
    ax.set_xticklabels(df.label)
    for lab, c in zip(ax.get_xticklabels(), colors):
        lab.set_color(c)
    ax.set_ylabel("µs per keypoint")
    save(fig, 4, "e", "time_per_keypoint")


if __name__ == "__main__":
    main()
