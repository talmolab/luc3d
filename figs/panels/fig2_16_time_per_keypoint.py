#!/usr/bin/env python3
"""
Fig 4e -- solve time per keypoint, FOUR bars: each solver beside its counterpart.

WHY FOUR AND NOT THREE. The three-bar version put Anipose's *linear* solve next to
LUC3D's *non-linear* refinement and invited the reading "our refinement is 1.6x
slower than Anipose" -- a category error. A closed-form SVD and an iterative robust
solve are not the same amount of arithmetic, and the panel was comparing across that
line. The bars are now PAIRED BY ALGORITHM CLASS:

    linear      LUC3D DLT              6.3  <->  Anipose triangulate      29.0
    non-linear  LUC3D refinement      44.0  <->  Anipose optim_points    228.8

Read across a pair and the comparison is real: **we are 4.6x faster on the linear
solve and 5.2x faster on the non-linear one.** Read down a column and you get the
cost of refining within one library.

(The non-linear ratio was 2.9x on the stride-60 export and is 5.2x here. Nothing
about either solver changed: `optim_points` is one global least-squares per SESSION,
so its cost per keypoint depends on how many keypoints a session has, and the sweep
now reaches the real session size -- 23,000 frames rather than 4,000. See
OPTIM_AMORTISED_FRAMES.)

THE ORDER DELIBERATELY DIFFERS FROM PANEL d, which runs Anipose / DLT / refined. The
pairing IS this panel's argument, and it cannot be made while also matching d's
order. What holds the two panels together is COLOUR -- green is Anipose in both,
salmon our DLT, teal our refinement -- so a reader can still map a column across the
figure by hue. The Anipose optim bar is hatched to mark it as the second Anipose
configuration rather than a fourth method.

WHICH ANIPOSE CONFIGURATION EACH BAR IS. `anipose triangulate` reads two flags,
both `False` by default (verified in `anipose/anipose.py`):
    optim: false, ransac: false  ->  CameraGroup.triangulate        29.0  (bar 2)
    optim: true                  ->  CameraGroup.optim_points      228.8  (bar 4)
    ransac: true                 ->  CameraGroup.triangulate_ransac 2467  (caption)
The ransac path is 85x the default and would flatten every other bar, so it is
reported in the caption rather than drawn. Naming the config on the artwork matters
because "Anipose" spans two orders of magnitude depending on it.

THE OPTIM BAR IS NOT A PER-KEYPOINT CONSTANT, and the whisker says so.
`optim_points` is one global `scipy.least_squares` per session, so its cost per
keypoint depends on the session's size: 668.6 us/kp at 1,000 frames and 276.5 at
2,000 while the fixed cost is still amortising, then 216.1 / 203.6 / 217.0 / 228.8
at 4,000 / 8,000 / 16,000 / 23,000. The bar is the largest run -- 23,000 frames,
which at stride 15 IS a whole session -- and the whisker spans the session-scale
sizes only (>= 4,000 frames); the two start-up points are in the caption, not
averaged into a number that would then describe neither regime.

The LUC3D bars come from the whole-corpus run (`fig4.json`, 17,013,412 keypoints);
the Anipose bars from `fig4_anipose.json`. To make that one comparison rather than
two machine loads, `fig4_anipose.py` re-times BOTH LUC3D solvers in its own sitting
and reports the disagreement -- 4% on DLT and 11% on the refinement here. That
matters more than usual for this figure: `fig4.json`'s figures are accumulated
inside the whole-corpus sweep, so a run sharing the machine with a dozen other
processes inflates them (measured: 7.67 / 64.35 us/kp under a 13-process load
against 6.32 / 44.00 for the same 17 M keypoints on a quiet machine, with every
accuracy field bit-identical). The deposited run is the quiet one.

All bars are the SOLVE ONLY: undistortion is excluded from every one, because
`CameraGroup.triangulate` undistorts inside the call and LUC3D outside it, and
charging one and not the other would be an artefact of where each library draws a
function boundary. Excluded: 0.57 us Anipose, 1.16 us LUC3D.

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
#: session-scale cost. SET FROM THE SWEEP ITSELF, and it moved when the export got
#: denser: at stride 15 a session is ~23,500 frames, and the sweep reads 669 us/kp
#: at 1,000 frames and 277 at 2,000 against 204-229 at every size from 4,000 up. So
#: the fixed cost has amortised by 4,000, not by 2,000 -- on the stride-60 export
#: (sessions of ~5,900 frames) the sweep stopped at 4,000 and read 383 / 115 / 122,
#: which put the knee one step earlier. Including a still-amortising point would
#: make the whisker say the session-scale cost varies 204-277 when it varies
#: 204-229.
OPTIM_AMORTISED_FRAMES = 4000


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
    deposit(df.drop(columns=["label"]), 2, "fig2g_time_per_keypoint.csv")

    # THE ACCURACY OF THE OPTIM ARM IS DEPOSITED HERE TOO, though this panel plots
    # only time. It is the evidence for the caption's claim that Anipose's optimiser
    # buys almost nothing over its own DLT, and a claim in a caption needs a file
    # behind it. `optim` (aniposelib's defaults) carries temporal smoothing that our
    # stride-15 sampling makes meaningless -- `optim_nosmooth` is the like-for-like
    # arm. Panel d deliberately has no optim column for that reason.
    po = load("fig4_anipose.json").get("per_session_optim") or []
    if po:
        deposit(pd.DataFrame(po), 2, "fig2g_anipose_optim_accuracy.csv")

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
    # THE HIGHEST INK, not the highest bar. The whisker can out-top every bar (at
    # stride 15 the optim bar is 229 us/kp and its whisker reaches 277), and pinning
    # the bracket row to the tallest BAR then ran it straight through the bar label
    # -- caught by lint_text as a 23% overlap of '228.8' with '3.6x ours'. Everything
    # above is measured from `cap` so the row cannot be reached by any mark again.
    cap = float(max(top, hi if hi == hi else 0.0))
    for i, r in df.iterrows():
        if r.lo is not None and r.hi is not None and r.hi > r.lo:
            ax.plot([i, i], [r.lo, r.hi], color=MUTED, lw=0.8, zorder=3)
            for y in (r.lo, r.hi):
                ax.plot([i - 0.09, i + 0.09], [y, y], color=MUTED, lw=0.8, zorder=3)
        y = max(r.us_per_keypoint, r.hi if r.hi is not None else 0)
        ax.text(i, y + cap * 0.025, f"{r.us_per_keypoint:.1f}", ha="center",
                va="bottom", fontweight="bold", color=colors[i])

    # THE TWO PAIRWISE RATIOS, which are the panel's whole point, drawn as brackets
    # over each pair rather than left to the reader's arithmetic.
    v = df.us_per_keypoint.values
    for (lo_i, hi_i), yf in (((0, 1), 1.16), ((2, 3), 1.16)):
        y = cap * yf
        ax.annotate("", xy=(hi_i, y), xytext=(lo_i, y),
                    arrowprops=dict(arrowstyle="-", lw=0.7, color=MUTED))
        ax.text((lo_i + hi_i) / 2, y + cap * 0.015,
                f"{v[hi_i] / v[lo_i]:.1f}× ours", ha="center", va="bottom",
                fontsize=6, fontweight="bold", color=MUTED)
    ax.set_ylim(0, cap * 1.36)
    ax.set_xticks(x)
    ax.set_xticklabels(df.label)
    for lab, c in zip(ax.get_xticklabels(), colors):
        lab.set_color(c)
    ax.set_ylabel("µs per keypoint")
    save(fig, 2, "g", "time_per_keypoint_src")


if __name__ == "__main__":
    main()
