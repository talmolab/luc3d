#!/usr/bin/env python3
"""
Fig 6c -- reprojection error and miss rate by session difficulty.

THIS PANEL EXISTS BECAUSE THE FIRST VERSION OF FIG 6 WAS REJECTED, CORRECTLY. That
version showed a rig scatter and a mean skeleton -- camera calibrations and an
average pose, neither of which says anything about what is IN these datasets. What
makes a session hard is measurable, and this is the measurement.

Difficulty is the corpus's own 2-7 rating from `_multi_master.tsv`, not a post-hoc
split, so it is not circular with the metric being plotted.

TWO AXES, BECAUSE THEY DISAGREE. Reprojection error rises only gently with
difficulty, while the MISS RATE -- the fraction of ground-truth keypoints with no
detection at all -- rises much more steeply. That is the same finding as Fig 7b from
the other direction: what a hard session costs you is detections, not precision on
the detections you get. Plotting only the error would have made difficulty look
almost free.

n per stratum is printed because the strata are far from balanced (13 sessions at
difficulty 7, 10 each at 2 and 4).

Source: figs/out/fig6_detections.json `by_difficulty`.

    python3 figs/panels/fig6_03_difficulty.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (GREY, PERIWINKLE, SALMON, deposit, panel, save,  # noqa: E402
                       text_legend, use)


def build() -> pd.DataFrame:
    bd = load("fig6_detections.json")["by_difficulty"]
    rows = []
    for k in sorted(bd, key=int):
        c = bd[k]
        if not c.get("n_sessions"):
            continue
        rows.append({"difficulty": int(k), "n_sessions": c["n_sessions"],
                     "n_keypoints": c["n_keypoints"], "err_p50": c["err_p50"],
                     "err_p95": c["err_p95"], "miss_rate": c["miss_rate"]})
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 6, "fig6c_difficulty.csv")

    fig, ax = panel("third", "std", key=2)
    ax.plot(df.difficulty, df.err_p50, color=PERIWINKLE, lw=2.0, zorder=3)
    ax.plot(df.difficulty, df.err_p50, "o", color=PERIWINKLE, ms=5, mec="white",
            mew=1.0, zorder=4)
    ax.set_xlabel("session difficulty (corpus rating)")
    ax.set_ylabel("reprojection error, median (px)")
    ax.set_ylim(0, df.err_p50.max() * 1.45)
    ax.set_xticks(df.difficulty)

    # Miss rate on its own axis: it is a fraction, not pixels, and it is the term
    # that actually moves with difficulty.
    ax2 = ax.twinx()
    ax2.spines["top"].set_visible(False)
    ax2.plot(df.difficulty, df.miss_rate * 100, color=SALMON, lw=2.0,
             ls=(0, (2.5, 1.5)), zorder=3)
    ax2.plot(df.difficulty, df.miss_rate * 100, "o", color=SALMON, ms=5,
             mec="white", mew=1.0, zorder=4)
    ax2.set_ylabel("keypoints with no detection (%)", color=SALMON)
    ax2.tick_params(axis="y", colors=SALMON)
    ax2.spines["right"].set_color(SALMON)
    ax2.set_ylim(0, df.miss_rate.max() * 100 * 1.45)

    for _, r in df.iterrows():
        ax.text(r.difficulty, 0, f"n={int(r.n_sessions)}", ha="center", va="bottom",
                color=GREY, fontsize=6.5)

    text_legend(ax, [("reprojection error", PERIWINKLE), ("miss rate", SALMON)],
                "above")
    save(fig, 6, "s3", "difficulty_dual")


if __name__ == "__main__":
    main()
