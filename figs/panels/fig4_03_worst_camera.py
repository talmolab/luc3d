#!/usr/bin/env python3
"""
Fig 4c -- how far the 3D point moves when the single worst-fitting camera is dropped,
and how often that move was an improvement.

The second half of the figure's claim. Rejecting one outlying camera moves a point
a median 7.2 mm in the stratum where that camera disagreed by >= 10 px -- an order
of magnitude more than any solver choice does. Stratified by how badly the dropped
camera disagreed, because the effect is entirely carried by the tail.

A DISPLACEMENT HAS NO SIGN, which is why `improved_frac` is now on the artwork.
"The 3D point moves 7.2 mm" is a magnitude: on its own it is equally consistent
with the drop fixing the point and with the drop wrecking it, and the boxes alone
cannot tell a reader which. `robust.*.improved_frac` was measured in the same pass
and was deposited but never plotted -- it is the fraction of keypoints where
dropping the camera actually LOWERED the error in the views that were kept -- so it
is printed against the box whose magnitude it qualifies: 87 / 83 / 96%.
Note what it is and is not: one solver, one camera removed, scored on the kept
views' own detections. It is not a comparison between solvers and it needs no
reference 3D.

It is printed rather than plotted as a fourth mark, and that is a size decision,
not a preference. A shared-x difference strip below the boxes (the construction 4d
uses) was built first and does not fit a 57.3 x 52 mm slot: the strip plus its own
tick row leaves the boxes ~24 mm of axes, and the rotated y label -- 28 mm of type --
is then clipped off the top of the page. The number carries the direction, which is
the whole content of the finding.

THE THREE BOXES ARE NOT DRAWN AT EQUAL WIDTH. n differs 45-fold across the strata
and three equal boxes read as three equal conditions -- the exact failure printing n
was meant to prevent. Width goes as sqrt(n), the standard variable-width boxplot,
and each stratum's share of the 4,253,636 keypoints is printed under its own tick,
so the 7.2 mm headline cannot be read as typical: that stratum is 1.6% of the data.

Source: figs/out/fig4.json `robust.{clean,mid,outlier}.{moved_mm,improved_frac,n}`.

    python3 figs/panels/fig4_03_worst_camera.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, GREY, INK, PINK, deposit, footnote, panel, save,  # noqa: E402
                       use)

STRATA = [("clean", "< 3"), ("mid", "3–10"), ("outlier", "≥ 10")]

#: Widest box, and the floor below which a box stops being visible at all. The
#: 1.6% stratum comes out at ~0.15 of the widest -- thin, which is the point.
W_MAX, W_MIN = 0.54, 0.09


def build() -> pd.DataFrame:
    rb = load("fig4.json")["robust"]
    total = sum(rb[k]["n"] for k, _ in STRATA if k in rb)
    rows = []
    for key, label in STRATA:
        if key not in rb:
            continue
        m = rb[key]["moved_mm"]
        rows.append({
            "stratum": key, "label": label, "n": rb[key]["n"],
            "share": rb[key]["n"] / total,
            "improved_frac": rb[key]["improved_frac"],
            "p5": m["p5"], "p25": m["p25"], "p50": m["p50"],
            "p75": m["p75"], "p95": m["p95"],
        })
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 4, "fig4c_worst_camera.csv")

    fig, ax = panel("third", "std")
    n_max = df.n.max()
    for i, r in df.iterrows():
        # Drawn from the deposited percentiles rather than from raw samples: the
        # measurement pass summarised 4.2 M keypoints and only the percentiles
        # survive into the JSON, so a real bxp is the honest primitive here.
        w = max(W_MIN, W_MAX * (r.n / n_max) ** 0.5)
        ax.bxp([{
            "med": r.p50, "q1": r.p25, "q3": r.p75,
            "whislo": r.p5, "whishi": r.p95, "fliers": [],
        }], positions=[i], widths=w, showfliers=False, manage_ticks=False,
            boxprops=dict(edgecolor=INK, lw=0.8, facecolor=PINK, alpha=0.55),
            medianprops=dict(color=INK, lw=1.4),
            whiskerprops=dict(color=INK, lw=0.8),
            capprops=dict(color=INK, lw=0.8),
            patch_artist=True)
        # "n=1,167,554" is 39 pt wide and the first box sits ~6 pt inside the axes, so
        # centred on that box the label crossed the left spine. The leftmost n is
        # therefore anchored at its box's centre and grows RIGHTWARD instead; the
        # others have room on both sides and stay centred.
        ax.text(i, r.p95 + 0.6, f"n={r.n:,}", va="bottom",
                ha="left" if i == 0 else "center", color=MUTED, fontsize=7)
        # +0.45 in y, not centred exactly on the median: box 0's median is 1.07 mm on
        # a 0-27 mm axis, so a vertically centred label straddled y = 0 and sat on the
        # x spine (the linter measured 12% of its box inked). x = 0.30 clears the
        # widest box, whose half-width is 0.27.
        ax.text(i + 0.30, r.p50 + 0.45, f"{r.p50:.1f}", ha="left", va="center",
                color=PINK, fontweight="bold")

    ax.set_xticks(range(len(df)))
    # THE SHARE AND THE DIRECTION GO IN THE TICK BLOCK, under the stratum each
    # belongs to, and that placement is forced. There is no room left in the data
    # area: the three n labels already sit at three different heights above the boxes
    # to keep clear of each other, so a second line on any of them collides with the
    # next; and stacking the direction beside the pink median instead put it across
    # the neighbouring box's whisker. Under the tick, each number is unambiguously
    # attached to one stratum and nothing else can move into it.
    ax.set_xticklabels([f"{r.label}\n{r.share:.0%}\n{r.improved_frac:.0%} better"
                        if r.share >= 0.10 else
                        f"{r.label}\n{r.share:.1%}\n{r.improved_frac:.0%} better"
                        for _, r in df.iterrows()])
    ax.set_xlabel("how far that camera disagreed (px)")
    # "the 3D point moves (mm)" is 28 mm of rotated type and the three-line tick
    # block leaves the axes ~28 mm, so the long form was clipped off the top of the
    # page. The x label carries "that camera", so "3D point moves" is not ambiguous.
    ax.set_ylabel("3D point moves (mm)")
    ax.set_ylim(0, None)
    footnote(ax, "under each: share of the keypoints;\n"
                 "% better: the kept views' error fell")
    save(fig, 4, "c", "worst_camera")


if __name__ == "__main__":
    main()
