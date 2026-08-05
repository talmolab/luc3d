#!/usr/bin/env python3
"""
Fig 6f -- the difficulty strata, as a table.

The numbers behind panel c, per stratum, so every point on that curve can be traced
to a session count and a keypoint count. Drawn as a rules-only table because these
are exact counts in four different units -- sessions, keypoints, pixels, percent --
and a bar chart of quantities that do not share a unit is decoration.

READ THE SESSION COUNTS. The strata are unbalanced and some are small; panel c plots
them as an even curve, and this table is what stops that curve being read as seven
equally-weighted measurements.

Source: figs/out/fig6_detections.json `by_difficulty`.

    python3 figs/panels/fig6_08_difficulty_strata.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, INK, SPAN, deposit, mm, save, use  # noqa: E402

COLS = ["Difficulty", "Sessions", "Keypoints", "Missing (%)", "Error p50 (px)",
        "Error p95 (px)", "> 20 px (%)"]


def main():
    use()
    bd = load("fig6_detections.json")["by_difficulty"]
    ks = [k for k in sorted(bd, key=int) if bd[k].get("n_sessions")]
    df = pd.DataFrame([{
        "difficulty": int(k), "sessions": bd[k]["n_sessions"],
        "keypoints": bd[k]["n_keypoints"], "missing_pct": bd[k]["miss_rate"] * 100,
        "err_p50": bd[k]["err_p50"], "err_p95": bd[k]["err_p95"],
        "over_tau_pct": bd[k]["frac_over_tau"] * 100} for k in ks])
    deposit(df, 6, "fig6f_difficulty_strata.csv")

    nrow = len(df)
    widths = [0.14, 0.13, 0.18, 0.15, 0.15, 0.15, 0.13]
    x0 = [sum(widths[:i]) for i in range(len(COLS))]

    fig, ax = plt.subplots(figsize=(mm(SPAN["full"]), mm(4.2 * (nrow + 2))),
                           layout="constrained")
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, nrow + 1.4)

    def row_y(i):
        return nrow - i + 0.1

    for j, c in enumerate(COLS):
        ax.text(x0[j], row_y(-1), c, fontweight="bold", va="center", color=INK,
                fontsize=7)
    for i, r in df.iterrows():
        vals = [f"{int(r.difficulty)}", f"{int(r.sessions)}",
                f"{int(r.keypoints):,}", f"{r.missing_pct:.1f}",
                f"{r.err_p50:.2f}", f"{r.err_p95:.2f}", f"{r.over_tau_pct:.2f}"]
        for j, v in enumerate(vals):
            ax.text(x0[j], row_y(i), v, va="center", fontsize=7,
                    color=INK if j == 0 else GREY)

    for y, lw in ((row_y(-1) + 0.6, 0.9), (row_y(-1) - 0.5, 0.6),
                  (row_y(nrow - 1) - 0.5, 0.9)):
        ax.plot([0, 1], [y, y], color=INK, lw=lw, clip_on=False)
    save(fig, 6, "f", "difficulty_strata")


if __name__ == "__main__":
    main()
