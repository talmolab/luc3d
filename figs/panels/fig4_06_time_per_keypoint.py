#!/usr/bin/env python3
"""
Fig 4f -- solve time per keypoint.

The cost side of the solver comparison, and the reason the ~3% out-of-sample
accuracy difference is not worth paying for by default: the refinement costs 6.9x
DLT. Measured in the same run as every other Fig 4 panel, so the ratio is not
quoted from a commit message (which recorded 4.6-6.1x on smaller runs).

Source: figs/out/fig4.json `methods.{dlt,ba}.us_per_keypoint`.

    python3 figs/panels/fig4_06_time_per_keypoint.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, PERIWINKLE, TEAL, deposit, panel, save, use  # noqa: E402


def build() -> pd.DataFrame:
    m = load("fig4.json")["methods"]
    return pd.DataFrame([
        {"solver": "DLT", "us_per_keypoint": m["dlt"]["us_per_keypoint"]},
        {"solver": "refined", "us_per_keypoint": m["ba"]["us_per_keypoint"]},
    ])


def main():
    use()
    df = build()
    deposit(df, 4, "fig4f_time_per_keypoint.csv")

    fig, ax = panel("quarter", "std")
    colors = [PERIWINKLE, TEAL]
    ax.bar(df.solver, df.us_per_keypoint, width=0.55, color=colors, zorder=2)
    for i, r in df.iterrows():
        # ONE DECIMAL, NOT ZERO. Rounded to integers the bars read "6" and "44",
        # and a reader who divides them gets 7.3x against a printed 6.9x -- the
        # ratio is right (43.79 / 6.33 = 6.92) and the labels were what lied.
        ax.text(i, r.us_per_keypoint + 1.0, f"{r.us_per_keypoint:.1f}", ha="center",
                va="bottom", fontweight="bold", color=colors[i])

    ratio = df.us_per_keypoint.iloc[1] / df.us_per_keypoint.iloc[0]
    ax.text(0.5, df.us_per_keypoint.max() * 1.22, f"{ratio:.1f}×", ha="center",
            va="bottom", fontweight="bold", color=GREY)
    ax.set_ylim(0, df.us_per_keypoint.max() * 1.38)
    ax.set_ylabel("µs per keypoint")
    save(fig, 4, "f", "time_per_keypoint")


if __name__ == "__main__":
    main()
