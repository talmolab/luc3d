#!/usr/bin/env python3
"""
Fig 4c -- how far the 3D point moves when the single worst-fitting camera is dropped.

The second half of the figure's claim. Rejecting one outlying camera moves a point
a median 7.2 mm in the stratum where that camera disagreed by >= 10 px -- an order
of magnitude more than any solver choice does. Stratified by how badly the dropped
camera disagreed, because the effect is entirely carried by the tail: the >= 10 px
stratum is ~1.5% of keypoints, and pooling would bury it.

The n per stratum is printed on the artwork for exactly that reason -- three boxes
of visibly different weight must not read as three equal conditions.

Source: figs/out/fig4.json `robust.{clean,mid,outlier}.moved_mm`.

    python3 figs/panels/fig4_03_worst_camera.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, INK, PINK, deposit, panel, save, use  # noqa: E402

STRATA = [("clean", "< 3"), ("mid", "3–10"), ("outlier", "≥ 10")]


def build() -> pd.DataFrame:
    rb = load("fig4.json")["robust"]
    rows = []
    for key, label in STRATA:
        if key not in rb:
            continue
        m = rb[key]["moved_mm"]
        rows.append({
            "stratum": key, "label": label, "n": rb[key]["n"],
            "p5": m["p5"], "p25": m["p25"], "p50": m["p50"],
            "p75": m["p75"], "p95": m["p95"],
        })
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 4, "fig4c_worst_camera.csv")

    fig, ax = panel("third", "std")
    for i, r in df.iterrows():
        # Drawn from the deposited percentiles rather than from raw samples: the
        # measurement pass summarised 4.2 M keypoints and only the percentiles
        # survive into the JSON, so a real bxp is the honest primitive here.
        ax.bxp([{
            "med": r.p50, "q1": r.p25, "q3": r.p75,
            "whislo": r.p5, "whishi": r.p95, "fliers": [],
        }], positions=[i], widths=0.5, showfliers=False, manage_ticks=False,
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
                ha="left" if i == 0 else "center", color=GREY, fontsize=7)
        ax.text(i + 0.30, r.p50, f"{r.p50:.1f}", ha="left", va="center",
                color=PINK, fontweight="bold")

    ax.set_xticks(range(len(df)))
    ax.set_xticklabels(df.label)
    ax.set_xlabel("how far that camera disagreed (px)")
    ax.set_ylabel("the 3D point moves (mm)")
    ax.set_ylim(0, None)
    save(fig, 4, "c", "worst_camera")


if __name__ == "__main__":
    main()
