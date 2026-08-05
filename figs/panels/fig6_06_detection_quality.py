#!/usr/bin/env python3
"""
Fig 6c -- detection quality across the corpus's own difficulty rating.

THREE SUB-PLOTS BECAUSE THE THREE QUANTITIES DISAGREE, and that disagreement is the
finding. Across difficulty 1 -> 7:

  * keypoints MISSING rises steeply (10.90x);
  * error WHEN PRESENT barely moves (1.29x on the mean);
  * the fraction beyond a 20 px tolerance rises (5.34x).

So a hard session does not make the detector imprecise -- it makes the detector
MISS. A single "error" axis would have shown a nearly flat line and concluded
difficulty is cheap. This is the same conclusion Fig 7e reaches from the tracker
side: the budget is dominated by false negatives.

THE MIDDLE PANEL PLOTS THE MEAN, AND WHICH SUMMARY IT IS MATTERS ENOUGH TO PRINT.
An earlier version of this panel plotted `err_p50` and printed `1.11x`, while
`CAPTIONS.md` and `captions/fig6.md` quote the paper's headline as "rises 1.29-fold
(3.67 -> 4.72 px)" -- the MEAN ratio. Both numbers are arithmetically right for their
own statistic (p50 3.1929/2.8893 = 1.105; mean 4.7248/3.6660 = 1.289), so this was
not a stale value but a silent change of estimator, and the artwork and the caption
disagreed by 16 %. Resolved in favour of the MEAN, for three reasons:

  1. it is the statistic the caption, the legacy panel and the caption's own "tail"
     argument are all written against;
  2. it is the one the outlier tail moves, and the tail is the point -- the p50
     rises only 1.11x precisely BECAUSE it hides this, which `captions/fig6.md:77`
     already says out loud ("the median is deliberately not reported");
  3. only the mean has a deposited between-session spread (`err_mean_sd`), so it is
     the only version of this panel that can carry an interval at all.

The statistic is now named ON the artwork ("mean +- s.d.", "95th pct"), so no reader
has to infer which of the two ratios they are looking at. The p50 is still deposited
in this panel's CSV.

ERROR BARS ARE +-1 S.D. BETWEEN SESSIONS, from `err_mean_sd` / `miss_rate_sd`, which
were deposited all along and went unplotted. They are load-bearing here, not
decoration: the strata are n = 4 to 13, so without them the difficulty-6 cell (n = 4,
miss 46.0 %) is drawn with exactly the same authority as the two n = 13 cells. The
per-stratum n is printed under the row for the same reason -- it was previously
printed only by `fig6_03_difficulty.py`, which saves the SUPPLEMENTARY 6s3 and is not
in the composite, so the requirement was met by a panel nobody sees.

THE TAIL IS BARS, NOT A LINE. `frac_over_tau` is a small fraction of a bounded
quantity and each stratum is an independent sample, not a step along a continuum
being interpolated; legacy drew it as labelled bars, and the labelled form is what
lets the 0.34 -> 1.83 range be read off directly at this size.

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
from src.style import INK, SALMON, TEAL, PERIWINKLE, deposit, grid, save, use  # noqa: E402

H = 35.0        # mm; this figure's rows are height-budgeted -- see assemble.py
FOOT = 0.135    # fraction of H reserved at the bottom for the n-per-stratum line

#: column, label, colour, scale to %, s.d. column, secondary series (p95),
#: where to park the "mean +- s.d." note in axes coordinates.
#: THE LABELS ARE TWO LINES ON PURPOSE. A rotated one-line y label is ~30 mm of
#: type against a ~20 mm axis at this row height, so it overflowed the axes and the
#: figure clipped its "(%)" -- and `lint_text.py` cannot see it, because PyMuPDF
#: reports off-page span boxes truncated at the mediabox (review finding C10).
PLOTS = [
    # 0.68, not 0.80: at 0.80 this note's span box overlapped the "10.90x" ratio's by
    # 21 % and the linter caught it. PyMuPDF span boxes carry the full ascender and
    # descender, so two 6-8 pt lines need ~0.14 of a ~22 mm axis between anchors.
    ("miss_rate", "keypoints\nmissing (%)", SALMON, 100.0, "miss_rate_sd", None,
     (0.05, 0.68)),
    ("err_mean", "error when\npresent (px)", PERIWINKLE, 1.0, "err_mean_sd",
     "err_p95", (0.52, 0.08)),
    ("frac_over_tau", "beyond\n20 px (%)", TEAL, 100.0, None, None, None),
]
FIELDS = ("miss_rate", "miss_rate_sd", "err_mean", "err_mean_sd", "err_p50",
          "err_p95", "err_p99", "frac_over_tau", "n_sessions", "n_keypoints")


def main():
    use()
    bd = load("fig6_detections.json")["by_difficulty"]
    ks = [k for k in sorted(bd, key=int) if bd[k].get("n_sessions")]
    df = pd.DataFrame([dict(difficulty=int(k),
                            **{c: bd[k].get(c) for c in FIELDS}) for k in ks])
    deposit(df, 6, "fig6c_detection_quality.csv")

    fig, axes = grid(1, 3, span="full", row=H)
    # rect is (left, bottom, WIDTH, HEIGHT) -- NOT (left, bottom, right, top).
    fig.get_layout_engine().set(rect=(0, FOOT, 1, 1 - FOOT))
    for ax, (col, label, color, scale, sdcol, second, note) in zip(axes, PLOTS):
        y = df[col] * scale
        sd = (df[sdcol] * scale if sdcol and df[sdcol].notna().all()
              else pd.Series(np.zeros(len(df))))
        top = float(max((y + sd).max(),
                        (df[second] * scale).max() if second else 0.0))

        if col == "frac_over_tau":
            ax.bar(df.difficulty, y, width=0.62, color=color, linewidth=0)
            for x, v in zip(df.difficulty, y):
                ax.text(x, v + top * 0.03, f"{v:.1f}", ha="center", va="bottom",
                        color=color, fontsize=5.6, fontweight="bold")
            top *= 1.22
        else:
            if second:
                ax.plot(df.difficulty, df[second] * scale, color=color, lw=1.1,
                        ls=(0, (2.5, 1.5)), zorder=2)
                ax.annotate("95th pct", (df.difficulty.iloc[-1],
                                         df[second].iloc[-1] * scale),
                            textcoords="offset points", xytext=(-3, 3), color=color,
                            fontsize=6.0, ha="right", fontweight="bold")
            ax.errorbar(df.difficulty, y, yerr=sd, fmt="none", ecolor=color,
                        elinewidth=0.7, capsize=1.4, capthick=0.7, zorder=3)
            ax.plot(df.difficulty, y, color=color, lw=1.8, zorder=4)
            ax.plot(df.difficulty, y, "o", color=color, ms=4.0, mec="white",
                    mew=0.8, zorder=5)
            # Name the statistic ON the panel, in its own colour -- the house move,
            # and the whole reason the 1.11x / 1.29x divergence was invisible. Parked
            # by hand in each sub-plot's own empty corner: offset from the middle
            # datum (the obvious choice) put it inside the miss-rate error bars.
            if note:
                ax.text(*note, "mean ± s.d.", transform=ax.transAxes, ha="left",
                        va="center", color=color, fontsize=6.0, fontweight="bold")
            top *= 1.22

        # The 1 -> 7 ratio, which is what distinguishes the three sub-plots.
        ax.text(0.03, 0.97, f"{y.iloc[-1] / y.iloc[0]:.2f}×", transform=ax.transAxes,
                va="top", color=color, fontsize=7.5, fontweight="bold")
        ax.set_xticks(df.difficulty)
        ax.set_xlabel("difficulty rating")
        ax.set_ylabel(label)
        ax.set_ylim(0, top)

    fig.text(0.5, FOOT * 0.42,
             "±1 s.d. between sessions · n = "
             + ", ".join(str(int(v)) for v in df.n_sessions)
             + " sessions at difficulty 1–7",
             ha="center", va="center", color=INK, fontsize=6.0)
    save(fig, 6, "c", "detection_quality")


if __name__ == "__main__":
    main()
