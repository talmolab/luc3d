#!/usr/bin/env python3
"""
Fig 4b -- 3D error against the number of cameras that saw the keypoint.

The figure's headline: on this rig 3D accuracy is set by how many cameras
contribute, not by the choice of triangulation solver. 4.75 mm at two cameras
falls to 1.22 mm at five, a 3.9x span, while the solver moves the residual by
~8% in sample and ~3% out of sample.

Source: figs/out/fig2.json (`per_session[].err3d_mm_by_anchor_count`), the same
50 BMimica sessions the rest of Fig 4 uses. Each session contributes its own
p25/p50/p75 and this panel plots the ACROSS-SESSION median of each, so the band
is the typical session's IQR rather than a pooled spread that would hide the
between-session variation.

The y axis is "3D error vs proofread (mm)", NOT reprojection error, and its floor
is a comparison floor: the reference is an external proofread reconstruction with
its own error (median reprojection 2.41 px), so 1.22 mm at five cameras is genuine
disagreement between two pipelines, not this one's absolute accuracy.

    python3 figs/panels/fig4_02_accuracy_vs_cameras.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import PINK, annotate_series, deposit, panel, save, use  # noqa: E402

KS = ["2", "3", "4", "5"]


def build() -> pd.DataFrame:
    per = load("fig2.json")["per_session"]
    rows = []
    for k in KS:
        got = [s["err3d_mm_by_anchor_count"][k] for s in per
               if k in s.get("err3d_mm_by_anchor_count", {})]
        rows.append({
            "cameras": int(k),
            "p25": median([g["p25"] for g in got]),
            "p50": median([g["p50"] for g in got]),
            "p75": median([g["p75"] for g in got]),
            "n_sessions": len(got),
        })
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 4, "fig4b_accuracy_vs_cameras.csv")

    fig, ax = panel("third", "std")
    ax.fill_between(df.cameras, df.p25, df.p75, color=PINK, alpha=0.20, lw=0)
    ax.plot(df.cameras, df.p50, color=PINK, lw=2.0, zorder=3)
    ax.plot(df.cameras, df.p50, "o", color=PINK, ms=6, mec="white", mew=1.0,
            zorder=4)

    lo, hi = df.p50.iloc[0], df.p50.iloc[-1]
    # The span is the panel's whole point, so it goes on the artwork rather than
    # only in the caption. This one is clear of the ribbon: p75 peaks at 8.6 mm at
    # two cameras and has fallen to ~4 by x = 3.5.
    annotate_series(ax, 3.5, df.p75.max() * 0.92, f"{lo / hi:.1f}× span",
                    PINK, ha="center")

    # THE IQR RIBBON COUNTS AS INK, so an end label placed anywhere NEAR its own
    # marker is on data: "4.7" offset up-and-right from (2, 4.75) measured 100% of its
    # box inked, sitting inside a band that runs 2.6-8.6 mm there, and "1.2" offset
    # below (5, 1.22) caught the band's lower edge at 9%.
    #
    # The one region adjacent to each end marker that the ribbon CANNOT reach is
    # outside it in x -- `fill_between` spans exactly 2..5 -- so the two values are
    # written horizontally outward from the end markers, and the x limits are widened
    # to make that margin real rather than letting the labels sit on the spine. The
    # limits move; no number and no datum does.
    ax.set_xlim(1.32, 5.62)
    ax.annotate(f"{lo:.1f}", (2, lo), textcoords="offset points", xytext=(-6, 0),
                ha="right", va="center", color=PINK, fontweight="bold")
    ax.annotate(f"{hi:.1f}", (5, hi), textcoords="offset points", xytext=(6, 0),
                ha="left", va="center", color=PINK, fontweight="bold")

    ax.set_xticks([2, 3, 4, 5])
    ax.set_xlabel("cameras that saw the keypoint")
    ax.set_ylabel("3D error vs proofread (mm)")
    ax.set_ylim(0, None)
    save(fig, 4, "b", "accuracy_vs_cameras")


if __name__ == "__main__":
    main()
