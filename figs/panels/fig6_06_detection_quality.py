#!/usr/bin/env python3
"""
Fig 6c -- detection quality across the corpus's own difficulty rating.

THREE SUB-PLOTS BECAUSE THE THREE QUANTITIES DISAGREE, and that disagreement is the
finding. Across difficulty 1 -> 7:

  * keypoints MISSING rises steeply (the ratio is printed on the panel);
  * error WHEN PRESENT barely moves;
  * the fraction beyond a 20 px tolerance rises.

So a hard session does not make the detector imprecise -- it makes the detector
MISS. A single "error" axis would have shown a nearly flat line and concluded
difficulty is cheap. This is the same conclusion Fig 7e reaches from the tracker
side: the budget is dominated by false negatives.

Difficulty is the corpus's own 1-7 rating from `_multi_master.tsv`, assigned before
any of this was measured, so it is not circular with the metric plotted against it.

Source: figs/out/fig6_detections.json `by_difficulty`.

    python3 figs/panels/fig6_06_detection_quality.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, INK, SALMON, TEAL, PERIWINKLE, deposit, grid, save, use  # noqa: E402

#: column, label, colour, scale to %, secondary series (p95) or None
PLOTS = [
    ("miss_rate", "keypoints missing (%)", SALMON, 100.0, None),
    ("err_p50", "error when present (px)", PERIWINKLE, 1.0, "err_p95"),
    ("frac_over_tau", "beyond 20 px (%)", TEAL, 100.0, None),
]


def main():
    use()
    bd = load("fig6_detections.json")["by_difficulty"]
    ks = [k for k in sorted(bd, key=int) if bd[k].get("n_sessions")]
    df = pd.DataFrame([dict(difficulty=int(k), **{c: bd[k].get(c)
                                                  for c in ("miss_rate", "err_p50",
                                                            "err_p95",
                                                            "frac_over_tau",
                                                            "n_sessions",
                                                            "n_keypoints")})
                       for k in ks])
    deposit(df, 6, "fig6c_detection_quality.csv")

    fig, axes = grid(1, 3, span="full", row=40.0)
    for ax, (col, label, color, scale, second) in zip(axes, PLOTS):
        y = df[col] * scale
        ax.plot(df.difficulty, y, color=color, lw=2.0, zorder=3)
        ax.plot(df.difficulty, y, "o", color=color, ms=4.5, mec="white", mew=0.9,
                zorder=4)
        if second and df[second].notna().all():
            ax.plot(df.difficulty, df[second] * scale, color=color, lw=1.2,
                    ls=(0, (2.5, 1.5)), zorder=2)
            ax.annotate("95th pct", (df.difficulty.iloc[-1],
                                     df[second].iloc[-1] * scale),
                        textcoords="offset points", xytext=(-4, 4), color=color,
                        fontsize=6.5, ha="right")
        # The 1 -> 7 ratio, which is what distinguishes the three panels.
        ax.text(0.03, 0.97, f"{y.iloc[-1] / y.iloc[0]:.2f}×", transform=ax.transAxes,
                va="top", color=color, fontsize=7.5, fontweight="bold")
        ax.set_xticks(df.difficulty)
        ax.set_xlabel("difficulty rating")
        ax.set_ylabel(label)
        ax.set_ylim(0, None)
    save(fig, 6, "c", "detection_quality")


if __name__ == "__main__":
    main()
