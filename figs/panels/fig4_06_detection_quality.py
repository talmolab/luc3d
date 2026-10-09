#!/usr/bin/env python3
"""
Fig 6c -- detection quality across the corpus's own difficulty rating.

THREE SUB-PLOTS BECAUSE THE THREE QUANTITIES DISAGREE, and that disagreement is the
finding. Across difficulty 1 -> 7:

  * keypoints MISSING rises steeply (10.81x);
  * error WHEN PRESENT barely moves (1.30x on the mean);
  * the fraction beyond a 20 px tolerance rises (5.72x).

(Those three were 10.90x / 1.29x / 5.34x while `fig4_detections.py` ran at stride 120.
It now runs at stride 1 -- EVERY frame, 187,134,382 keypoint comparisons instead of
1,561,915 -- and the three fold changes moved by 0.8 %, 0.8 % and 7 %. The subsample
was unbiased for the first two; the >20 px fraction is a tail statistic and moved
most, which is what a tail statistic does under a 120x smaller sample.)

So a hard session does not make the detector imprecise -- it makes the detector
MISS. A single "error" axis would have shown a nearly flat line and concluded
difficulty is cheap. This is the same conclusion Fig 7e reaches from the tracker
side: the budget is dominated by false negatives.

THE MIDDLE PANEL PLOTS THE MEAN, AND WHICH SUMMARY IT IS MATTERS ENOUGH TO PRINT.
An earlier version of this panel plotted `err_p50` and printed `1.11x`, while
`CAPTIONS.md` and `captions/fig6.md` quote the paper's headline as "rises 1.29-fold
(3.67 -> 4.72 px)" -- the MEAN ratio. Both numbers are arithmetically right for their
own statistic (at stride 120: p50 3.1929/2.8893 = 1.105; mean 4.7248/3.6660 = 1.289;
at stride 1: p50 3.1985/2.8832 = 1.109, mean 4.7412/3.6490 = 1.299), so this was
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
from src.style import INK, deposit, grid, panel, save, use  # noqa: E402

#: Panel height in mm; this figure's rows are height-budgeted -- see assemble.py.
#: 32, down from 34: the ink measured 32.3 of 34.0 mm on the 300 dpi render, so the
#: rest was margin (review findings 6.12 / C9). This panel is alone in its row, so the
#: 2 mm comes straight off the page. 32 is the measured FLOOR, not a guess: at 31 the
#: "mean ± s.d." note in the middle sub-plot lands on its own error bars (`lint_text.py`
#: ON DATA, 5% of its box inked), because that note is parked in AXES fractions while
#: the bars it has to clear are in data units.
H = 32.0
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
    # ONE NEUTRAL HUE (review round 3). The first recolour put the three metrics on
    # the level() ramp, but that ramp means ORDERED STRATA set-wide and 6d directly
    # below uses it for animal counts -- same hues, two meanings on one page. These
    # sub-plots are separate axes with their own y-labels; they need no
    # distinguishing colour at all.
    ("miss_rate", "keypoints\nmissing (%)", INK, 100.0, "miss_rate_sd", None,
     (0.05, 0.68)),
    ("err_mean", "error when\npresent (px)", INK, 1.0, "err_mean_sd",
     "err_p95", (0.52, 0.08)),
    ("frac_over_tau", "beyond\n20 px (%)", INK, 100.0, None, None, None),
]
#: THE 2026-10-07 FIG 4b VARIANT (FIG_TAG=b) draws ONLY the error-when-present
#: sub-plot, as panel c at third width (Eric: "take the D on the left but maybe do
#: 98th percentile"): mean +- s.e.m. between sessions, plus a dashed 98th-percentile
#: line. See `main_v2`. The miss rate is not repeated there and beyond-20-px is dropped.
# 2026-10-09: the former Fig 3c/4c/6c variant (>= 5 visible body keypoints, tail excluded) is now the base figure: the single error-when-present panel (c) is the default.
V2 = True

FIELDS = ("miss_rate", "miss_rate_sd", "err_mean", "err_mean_sd", "err_p50",
          "err_p95", "err_p98", "err_p99", "frac_over_tau", "n_sessions", "n_keypoints")


def main():
    use()
    bd = load("fig6_detections.json")["by_difficulty"]
    ks = [k for k in sorted(bd, key=int) if bd[k].get("n_sessions")]
    df = pd.DataFrame([dict(difficulty=int(k),
                            **{c: bd[k].get(c) for c in FIELDS}) for k in ks])
    deposit(df, 4, "fig4e_detection_quality.csv")

    # full -> two-thirds span in the 2026-08-19 re-letter: this panel now shares
    # its row with the animal-count control (Eric: "we should still have the
    # detection quality one next to d"). Half span was tried first and is too
    # tight for three annotated sub-plots -- the fold ratios collided with the
    # "95th pct" / "mean +- s.d." notes and the third x-label clipped -- so the
    # row splits third + two-thirds (57.3 + 117.3 + 4 mm gutter = 178.6 mm).
    fig, axes = grid(1, 3, span="two-thirds", row=H)
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
    # g -> e in the 2026-08-19 re-letter (the difficulty grid leads the figure)
    save(fig, 4, "e", "detection_quality")


def main_v2():
    """Panel c of the 2026-10-07 Fig 4b: error when present, mean +- s.e.m. between
    sessions, dashed 98th percentile (the per-session p98, averaged per stratum --
    the same estimator the 95th-pct line always used)."""
    use()
    # proofread 2D labels, tail excluded -- what Fig 4c always drew (was FIG_VARIANT)
    j = load("fig6_detections_proofread_notail.json", variant=False)
    bd = j["by_difficulty"]
    if any(bd[k].get("err_p98") is None for k in bd):
        sys.exit("fig4c error: deposit has no err_p98 -- re-run figs/fig4_detections.py "
                 "(p98 added 2026-10-07)")
    per = pd.DataFrame([{"difficulty": int(q["difficulty"]),
                         "err_mean": q["det_error"]["mean"]} for q in j["sessions"]])
    g = per.groupby("difficulty").err_mean
    df = pd.DataFrame({"difficulty": sorted(per.difficulty.unique())})
    df["err_mean"] = df.difficulty.map(g.mean())
    df["err_mean_sem"] = df.difficulty.map(g.sem())
    df["err_p98"] = df.difficulty.map(lambda d: bd[str(d)]["err_p98"])
    # Fig 4c (FIG_TAG=c, Eric 2026-10-09): 80th and 95th percentile lines beside the 98th
    # (tried 99th, 50th and 75th; settled on 80th)
    multi = True
    df["err_p95"] = df.difficulty.map(lambda d: bd[str(d)]["err_p95"])
    df["err_p80"] = df.difficulty.map(lambda d: bd[str(d)]["err_p80"])
    df["n_sessions"] = df.difficulty.map(g.size())
    # the session means must reproduce the deposit's own stratum means
    for _, r in df.iterrows():
        assert abs(r.err_mean - bd[str(int(r.difficulty))]["err_mean"]) < 1e-9
    deposit(df, 4, "fig4c_error_when_present.csv")

    fig, ax = panel("third", "std")
    if multi:
        # three tail percentiles, one ink, told apart by dash and a direct label at the
        # right end (no key needed)
        for col, lab, ls in (("err_p98", "98th", (0, (2.5, 1.5))),
                             ("err_p95", "95th", (0, (5, 1.5))),
                             ("err_p80", "80th", (0, (1, 1.2)))):
            ax.plot(df.difficulty, df[col], color=INK, lw=1.1, ls=ls, zorder=2)
            # the 80th runs just above the mean line: lift its label, drop the mean's
            ax.annotate(lab, (df.difficulty.iloc[-1], df[col].iloc[-1]),
                        textcoords="offset points",
                        xytext=(3, 3.5 if col == "err_p80" else 0), color=INK,
                        fontsize=6.0, ha="left", va="center", fontweight="bold",
                        annotation_clip=False)
    else:
        ax.plot(df.difficulty, df.err_p98, color=INK, lw=1.1, ls=(0, (2.5, 1.5)), zorder=2)
        ax.annotate("98th pct", (df.difficulty.iloc[-1], df.err_p98.iloc[-1]),
                    textcoords="offset points", xytext=(-3, 3), color=INK,
                    fontsize=6.0, ha="right", va="bottom", fontweight="bold")
    ax.errorbar(df.difficulty, df.err_mean, yerr=df.err_mean_sem, fmt="none",
                ecolor=INK, elinewidth=0.7, capsize=1.4, capthick=0.7, zorder=3)
    ax.plot(df.difficulty, df.err_mean, color=INK, lw=1.8, zorder=4)
    ax.plot(df.difficulty, df.err_mean, "o", color=INK, ms=4.0, mec="white",
            mew=0.8, zorder=5)
    ytop = df.err_p98.max() * 1.25
    # Fig 4c: the 50th-pct label sits at the mean line's right end, so the
    # "mean +- s.e.m." note moves to the empty upper left there
    if multi:   # the mean line gets a right-end label like the percentiles
        ax.annotate("mean", (df.difficulty.iloc[-1], df.err_mean.iloc[-1]),
                    textcoords="offset points", xytext=(3, -3.5), color=INK,
                    fontsize=6.0, ha="left", va="center", fontweight="bold",
                    annotation_clip=False)
    ax.text(*((0.04, 0.97) if multi else (0.97, 0.06 + df.err_mean.max() / ytop)),
            "error bars ± s.e.m." if multi else "mean ± s.e.m.", transform=ax.transAxes,
            ha="left" if multi else "right", va="top" if multi else "bottom",
            color=INK, fontsize=6.0, fontweight="bold")
    ax.set_xticks(df.difficulty)
    ax.set_xlabel("difficulty rating")
    # "reprojection error", not "error when present" (Eric, 2026-10-08): the
    # reference is the proofread 3D pose reprojected into each camera.
    ax.set_ylabel("reprojection error (px)")
    ax.set_ylim(0, ytop)
    if multi:
        ax.set_xlim(0.6, 7.9)   # room for the right-end percentile labels
    for _, r in df.iterrows():
        print(f"  d{int(r.difficulty)}: mean {r.err_mean:.2f} ± {r.err_mean_sem:.2f} "
              f"(sem, n={int(r.n_sessions)})  p98 {r.err_p98:.2f}")
    save(fig, 4, "c", "error_when_present")


if __name__ == "__main__":
    main_v2() if V2 else main()
