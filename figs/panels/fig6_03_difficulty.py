#!/usr/bin/env python3
"""
Fig 6s3 (SUPPLEMENTARY) -- reprojection error and miss rate by session difficulty,
on ONE pair of axes.

NOT the main-figure 6c, which is `fig6_06_detection_quality.py`. This file's docstring
used to say "Fig 6c" while `save()` writes `fig6s3_difficulty_dual`, so a caption
written from it cited the wrong panel. Kept as a supplement because it is the only
place the two quantities appear on a shared x with a twin y, which is the compact form
worth having next to the three-panel main version.

THIS PANEL EXISTS BECAUSE THE FIRST VERSION OF FIG 6 WAS REJECTED, CORRECTLY. That
version showed a rig scatter and a mean skeleton -- camera calibrations and an
average pose, neither of which says anything about what is IN these datasets. What
makes a session hard is measurable, and this is the measurement.

Difficulty is the corpus's own 1-7 rating from `_multi_master.tsv`, not a post-hoc
split, so it is not circular with the metric being plotted. (This docstring said
"2-7"; the deposit has all seven ratings, 1 through 7.)

TWO AXES, BECAUSE THEY DISAGREE. Reprojection error rises only gently with
difficulty, while the MISS RATE -- the fraction of ground-truth keypoints with no
detection at all -- rises much more steeply. That is the same finding as Fig 7e from
the other direction: what a hard session costs you is detections, not precision on
the detections you get. Plotting only the error would have made difficulty look
almost free.

n per stratum is printed -- as a "rating:n" list under the x axis -- because the
strata are far from balanced: n = 12, 13, 9, 13, 10, 4, 13 over ratings 1-7, so 13
sessions at difficulty 7 against only 4 at difficulty 6. (This docstring previously
said "10 each at 2 and 4"; the deposit says 13 at each.)

Source: figs/out/fig6_detections.json `by_difficulty`.

    python3 figs/panels/fig6_03_difficulty.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (footnote, PERIWINKLE, SALMON, deposit, panel, save,  # noqa: E402
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

    # n per stratum goes UNDER the axis as one "rating:n" list, not as seven labels
    # inside the plot: at this panel's width the in-plot labels were ~12 mm apart on
    # a ~6 mm tick pitch, so they overprinted each other, the y axis and the
    # difficulty-1 miss-rate marker. The counts themselves are unchanged.
    text_legend(ax, [("reprojection error", PERIWINKLE), ("miss rate", SALMON)],
                "above")
    footnote(ax, "n = " + ", ".join(f"{int(r.n_sessions)}"
                                    for _, r in df.iterrows()) + " sessions")
    save(fig, 6, "s3", "difficulty_dual")


if __name__ == "__main__":
    main()
