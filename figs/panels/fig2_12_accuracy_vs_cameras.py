#!/usr/bin/env python3
"""
Fig 4b -- held-out reprojection error vs the number of cameras in the solve, BOTH
LUC3D solvers. REFERENCE-FREE.

The figure's headline: on this rig accuracy is set by how many cameras contribute,
not by the choice of solver. Both solvers improve monotonically as views are added,
and the two curves stay within ~0.2 px of each other at every k.

THE AXIS CHANGED FROM mm TO px, AND THAT WAS FORCED BY A MEASUREMENT.
---------------------------------------------------------------------
This panel used to plot 3D distance to the proofread reference. That axis cannot
compare two solvers, and `figs/fig4_move_geometry.mjs` is the proof rather than the
assertion. Per keypoint, with D = DLT, R = refined, G = reference:

    k = 5:  |D-G| 1.214 mm   |R-D| 1.249 mm   |R-G| 1.852 mm   cos(R-D, G-D) 0.066
    k = 2:  |D-G| 2.697 mm   |R-D| 0.559 mm   |R-G| 2.895 mm   cos 0.002

The refinement MOVES about as far as the reference sits from the DLT, in a direction
essentially UNCORRELATED with the direction to the reference. Adding a displacement
orthogonal to an existing error always increases the distance: the perpendicular
prediction at k = 2 is 2.917 mm against 2.895 measured. So the mm axis was reporting
"the refinement moved" and reading it out as "the refinement is worse", whichever way
it moved -- an arithmetic certainty, not a measurement.

It also rules out the opposite reading. A solver genuinely trading 3D accuracy for 2D
fit would move systematically AWAY from truth: cos well below zero, |R-G| approaching
|D-G| + |R-D| = 2.463 mm at k = 5. Measured 1.852, cos slightly POSITIVE. The
refinement is not wrecking the 3D; the reference cannot see what it did.

WHAT IS PLOTTED NOW. Solve from k of the five cameras (every C-choose-k subset),
project into each camera OUTSIDE the subset, and score against that camera's RAW
DETECTION in its native, still-distorted pixels. No reference 3D enters it, and
neither solver optimises it -- the refinement minimises reprojection error in the
views it WAS given, never the held-out one. That makes this a genuine out-of-sample
test, and it is the metric on which the two solvers can actually be ranked.

**k STOPS AT 4, and that is a hard limit of a five-camera rig, not a choice**: at
k = 5 there is no camera left to hold out. The old mm axis reached k = 5, so the
"3.9x from two to five views" span is not available here; the reference-free span is
2 -> 4. Both are in the caption, each labelled with what it can support.

The px effect is smaller than the old mm effect for a real reason, not because the
measurement got worse: held-out reprojection error has a floor set by the detector's
own noise in the held-out view, which no solve can remove.

Source: figs/out/fig4_by_views.json `heldout_px_across_sessions[k].{dlt,ba}`, written
by figs/fig4_by_views.mjs with the REAL branch solvers. The same file's
`err3d_mm_across_sessions` carries the old mm arm, deposited and deliberately not
plotted.

NOT fig2.json's `by_anchor_count`, despite the similar name: that arm scores against
the REPROJECTED REFERENCE (`gtk`, "3D-consistent target"), so it inherits the
reference's error and is not reference-free.

ERROR BARS ARE THE MEDIAN'S 95% CI, DISTRIBUTION-FREE (Eric, 2026-08-18: "we also
need error bars for 4b and 4c"). Each session gives one number per (k, solver) -- its
own median held-out error -- and the plotted point is the median of those 50. The bar
is the classic order-statistic interval on that median: for n = 50 the 18th and 33rd
sorted sessions, whose exact binomial coverage is 96.7%. No bootstrap, so no seed and
no run-to-run drift in a manuscript figure; asymmetric, because the interval is made
of real sessions rather than of a symmetric standard error.

IT IS THE PRECISION OF THE PLOTTED POINT, NOT THE SPREAD OF THE SESSIONS -- those are
different quantities here and the difference is large: at k = 2 the DLT's 50 session
medians run 3.38-4.45 px (IQR) while the median's CI is 4.11-4.40. The between-session
spread was drawn on this panel once, as an IQR ribbon, and review removed it in
2026-08-14 as a redraw of Fig 2c's boxes; a CI is the thing that ribbon was being
misread AS ("an unnamed ribbon is read as [a confidence interval on the plotted
median]", the footnote's own words), so this adds the missing quantity rather than
putting the removed one back.

AND THE BARS UNDERSTATE THE SOLVER COMPARISON, WHICH IS PAIRED. The two solvers run on
the same 50 sessions, so the honest test of the crossing is the per-session difference,
not whether two unpaired intervals overlap -- and they do overlap at k = 3 and k = 4
while the paired difference is decisive: refined MINUS DLT is +0.111 px at k = 2 (sd
0.031, DLT lower in 50/50 sessions), -0.069 at k = 3 (34 of 50 favour refined) and
-0.098 at k = 4. The paired numbers are deposited in the CSV and quoted in the caption;
the bars on the artwork answer "how well do we know this point", which is what an error
bar answers.

Each session contributes its own p25/p50/p75 and the deposit's `*_p25`/`*_p75` are the
ACROSS-SESSION median of each, i.e. the typical session's IQR rather than a pooled
spread that would hide the between-session variation. (`fig4.json`'s `heldout_by_views` is
the pooled version of a similar measurement and runs ~5-10% lower; it pools over
keypoints instead of sessions and holds out one fixed camera rather than scoring
every camera outside the subset. Same story, different estimator -- do not mix the
two sets of numbers.)

    python3 figs/panels/fig4_02_accuracy_vs_cameras.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, deposit, entity, footnote, panel,  # noqa: E402
                       save, use)

#: Set-wide entity colours -- see the note in `fig4_01_solvers.py`. This panel used
#: PINK for its single curve, which is the Fig-2-provenance hue; with two solvers on
#: it, the curves have to carry the same meaning they carry in d and e or a reader
#: learns one mapping per panel.
SOLVERS = [("dlt", "DLT", entity("dlt")), ("ba", "refined", entity("refined"))]


#: Distribution-free 95% CI of a median from n sorted observations: the (k, n+1-k)
#: order statistics for the largest k whose binomial coverage still clears 0.95. At
#: n = 50 that is the 18th and 33rd session, coverage 96.7%. Deterministic -- the
#: alternative, a bootstrap, would put a random number generator in the artwork.
def _median_ci(v):
    from scipy import stats
    v = np.sort(np.asarray(v, dtype=float))
    n = len(v)
    k = 1
    while k < n // 2:
        if stats.binom.cdf(n - (k + 1), n, 0.5) - stats.binom.cdf(k, n, 0.5) < 0.95:
            break
        k += 1
    cov = float(stats.binom.cdf(n - k, n, 0.5) - stats.binom.cdf(k - 1, n, 0.5))
    return float(v[k - 1]), float(v[n - k]), cov, int(n)


def build() -> pd.DataFrame:
    j = load("fig4_by_views.json")
    a = j["heldout_px_across_sessions"]
    per = j["per_session"]
    rows = []
    for k in sorted(int(x) for x in a):
        g = a[str(k)]
        row = {"cameras": k}
        for key, _, _ in SOLVERS:
            row[f"{key}_p25"] = g[key]["p25"]
            row[f"{key}_p50"] = g[key]["p50"]
            row[f"{key}_p75"] = g[key]["p75"]
            # ONE VALUE PER SESSION, which is what the CI is over. The deposit's p50
            # is the median of exactly these, computed on the JS side, so equality is
            # a cross-check on the join rather than a tautology -- a drift means the
            # bar and the point are not the same population.
            vals = [s_["heldout_px_by_k"][str(k)][key]["p50"] for s_ in per
                    if str(k) in s_.get("heldout_px_by_k", {})]
            lo, hi, cov, n = _median_ci(vals)
            if abs(np.median(vals) - g[key]["p50"]) > 1e-9 * max(1.0, g[key]["p50"]):
                sys.exit(f"fig4b: k={k} {key}: median of the {n} session medians "
                         f"{np.median(vals):.9f} != deposit p50 {g[key]['p50']:.9f}; "
                         f"the error bar would not belong to the plotted point")
            row[f"{key}_ci_lo"] = lo
            row[f"{key}_ci_hi"] = hi
            row[f"{key}_ci_coverage"] = cov
            row[f"{key}_n_ci_sessions"] = n
            # THE PAIRED DIFFERENCE, deposited because the bars cannot carry it: the
            # solvers share sessions, so this -- not the overlap of two unpaired
            # intervals -- is the test of the crossing.
            if key == "ba":
                d = np.array([s_["heldout_px_by_k"][str(k)]["ba"]["p50"]
                              - s_["heldout_px_by_k"][str(k)]["dlt"]["p50"]
                              for s_ in per
                              if str(k) in s_.get("heldout_px_by_k", {})])
                row["paired_ba_minus_dlt_mean"] = float(d.mean())
                row["paired_ba_minus_dlt_sd"] = float(d.std(ddof=1))
                row["paired_ba_lower_in_n"] = int((d < 0).sum())
        row["n_sessions"] = g["dlt"]["n_sessions"]
        row["n_values"] = g["dlt"]["n_values"]
        row["ratio_ba_over_dlt"] = row["ba_p50"] / row["dlt_p50"]
        # The EFFECTIVE keypoint stride, read from the run rather than typed in: the
        # footnote used to say "stride 240" (a stride-60 export sampled every 4th
        # keypoint) and would have gone on saying so after the run got denser.
        row["stride"] = j["export_stride"] * j["stride_within_export"]
        row["keypoints_used"] = j["keypoints_used"]
        rows.append(row)
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 2, "fig2e_accuracy_vs_cameras.csv")

    fig, ax = panel("third", "std")
    for key, _, color in SOLVERS:
        # ONE BAND ONLY, the DLT's. Two overlapping 18%-alpha ribbons read as three
        # bands of four tints and neither curve's own spread stays legible. The
        # refinement's IQR is deposited in the CSV and is the same shape; the drawn
        # band belongs to the curve the span is quoted for.
        if key == "dlt":
            # THE DLT IQR BAND IS GONE (review 2026-08-14): the same measurement's
            # per-session spread is now Fig 2c's boxes and dots, and drawing it twice
            # invited "why do these disagree" for two renderings of one deposit. This
            # panel keeps what is UNIQUE to it -- the refined arm and the crossing.
            _band_dropped = True
            if False:
                ax.fill_between(df.cameras, df[f"{key}_p25"], df[f"{key}_p75"],
                            color=color, alpha=0.18, lw=0)
        ax.plot(df.cameras, df[f"{key}_p50"], color=color, lw=2.0, zorder=3)
        # BARS AT THE EXACT k, NOT DODGED. A dodge would move a marker off the camera
        # count it belongs to for the sake of legibility, and the marker's white ring
        # already separates the two where the intervals overlap.
        ax.errorbar(df.cameras, df[f"{key}_p50"],
                    yerr=[df[f"{key}_p50"] - df[f"{key}_ci_lo"],
                          df[f"{key}_ci_hi"] - df[f"{key}_p50"]],
                    fmt="none", ecolor=color, elinewidth=1.0, capsize=2.4,
                    capthick=1.0, zorder=3)
        ax.plot(df.cameras, df[f"{key}_p50"], "o", color=color, ms=5, mec="white",
                mew=1.0, zorder=4)

    ks = list(df.cameras)
    ax.set_xlim(ks[0] - 0.72, ks[-1] + 0.72)
    # END LABELS written horizontally OUTWARD from the end markers -- the one region
    # next to a marker the ribbon cannot reach, since `fill_between` spans exactly the
    # plotted k range. The x limits are widened to make that margin real rather than
    # letting the labels sit on the spine. The limits move; no number and no datum does.
    # STAGGERED VERTICALLY, because the two curves are 0.11 px apart at k = 2 and
    # 0.19 px at k = 4 -- close enough that labels placed at their own y values
    # overlapped 72% and 54%. Each label is pushed in the direction its curve sits
    # relative to the other, so the pair reads in the same order as the curves and the
    # offset itself carries which is which. The anchor point does not move.
    for end, x, dx, ha in ((0, ks[0], -6, "right"), (-1, ks[-1], 6, "left")):
        vals = {key: df[f"{key}_p50"].iloc[end] for key, *_ in SOLVERS}
        top = max(vals, key=vals.get)
        for key, _, color in SOLVERS:
            dy = 5 if key == top else -5
            ax.annotate(f"{vals[key]:.2f}", (x, vals[key]),
                        textcoords="offset points", xytext=(dx, dy), ha=ha,
                        va="center", color=color, fontweight="bold", fontsize=6)

    # THE LIMITS FOLLOW THE INK, and the ink is now the CI bars, not the retired IQR
    # ribbon: `*_p25`/`*_p75` are still deposited but nothing draws them, so sizing the
    # axis by them left the bars in the middle third of the panel.
    lo_y = min(df[f"{k}_ci_lo"].min() for k, *_ in SOLVERS)
    hi_y = max(df[f"{k}_ci_hi"].max() for k, *_ in SOLVERS)
    # NOT ZERO-BASED. A reprojection floor set by detector noise means zero is not a
    # reachable value and anchoring there compresses the whole effect into the top
    # third of the panel. The axis starts below the lowest p25 drawn.
    ax.set_ylim(max(0.0, lo_y - 0.35), hi_y * 1.16)

    for i, (key, name, color) in enumerate(SOLVERS):
        s = df[f"{key}_p50"].iloc[0] / df[f"{key}_p50"].iloc[-1]
        ax.text(ks[-1] + 0.62, hi_y * (1.13 - 0.055 * i), f"{s:.2f}× {name}",
                ha="right", va="top", fontweight="bold", color=color, fontsize=6)

    # THE CROSSING IS THE RESULT, so it is named. The refinement is WORSE than the DLT
    # at two views and better at three and four -- a sign flip, which is the one thing
    # a rigged metric cannot produce and therefore the strongest evidence this axis is
    # measuring the solvers rather than itself.
    #
    # BELOW THE BAND, ON ONE LINE. The two-line version sat inside the DLT ribbon at
    # 91% inked. The ribbon's lower edge falls from 2.63 px at k = 2 to 2.06 at k = 4
    # while the axis starts at ~1.56, so the strip under it is the only region clear
    # at EVERY k -- and it is only ~0.5 px tall, which is why this is one short line
    # rather than two.
    y0 = max(0.0, lo_y - 0.35)
    # The crossing sentence ("refined worse at 2 views, better at 3-4") moved to the
    # legend (review round 3) -- the same prose class the 7a purge removed, and the
    # crossing is visible in the two curves. 5.4 pt was also under Nature's 5 pt
    # floor once print-scaled.

    ax.set_xticks(ks)
    ax.set_xlabel("cameras in the solve")
    ax.set_ylabel("error in a camera it\nnever saw (px)")

    # THE PROTOCOL AND THE BAND, both on the axis, because both are read wrongly by
    # default. "band: median session p25-p75" is the ACROSS-SESSION median of each
    # session's own p25/p50/p75 -- neither a confidence interval on the plotted median
    # nor any one session's IQR, and an unnamed ribbon is read as the former.
    footnote(ax, f"all C-choose-k subsets · stride {int(df.stride.iloc[0])}\n"
                 "same held-out measurement as Fig 2c\n"
                 f"bars: distribution-free 95% CI of the median over "
                 f"{int(df.dlt_n_ci_sessions.iloc[0])} sessions "
                 f"({df.dlt_ci_coverage.iloc[0]:.1%} exact coverage); the solver "
                 f"comparison is PAIRED -- refined minus DLT "
                 + " · ".join(f"k={int(r.cameras)} {r.paired_ba_minus_dlt_mean:+.3f} px "
                              f"(refined lower in {int(r.paired_ba_lower_in_n)}/"
                              f"{int(r.dlt_n_ci_sessions)})"
                              for r in df.itertuples()))
    save(fig, 2, "e", "accuracy_vs_cameras")


if __name__ == "__main__":
    main()
