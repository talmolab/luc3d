#!/usr/bin/env python3
"""
Fig 4c -- reprojection error with all cameras against the same solve with the
worst-fitting view dropped.

REDESIGNED 2026-08-15 (Eric: "I don't understand the x axis at all ... just show the
error with all cameras and then the error when we drop the worst camera"). Two
conditions on the x axis, nothing else: the solve from ALL views, scored in the KEPT
views against their own detections, and the same solve re-run with the single
worst-fitting view excluded, scored in the SAME kept views. The paired change is the
finding: dropping a disagreeing view lowers the error in every view you keep.

The teal pair is the POOLED mean (weighted by each stratum's n -- means pool exactly;
percentiles do not). The three thin grey pairs are the deposit's three
disagreement strata (how far the worst view sat from the all-view solution), drawn so
the spread is visible without an axis of bins; their n's span 4.7M / 12.1M / 0.27M
solves and the outlier stratum is where the drop buys 7 mm of 3D movement (the old
panel's headline, now in the legend).

Source: figs/out/fig4.json `robust.{clean,mid,outlier}.kept_view_err_{before,after}`.

    python3 figs/panels/fig4_03_worst_camera.py
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (MUTED, GREY, INK, TEAL, deposit, footnote, panel, save, text_legend,  # noqa: E402
                       use)

STRATA = [("clean", "< 3"), ("mid", "3–10"), ("outlier", "≥ 10")]

#: Widest box, and the floor below which a box stops being visible at all. The
#: 1.6% stratum comes out at ~0.15 of the widest -- thin, which is the point.
#: One width for all three boxes; see the docstring. W_MIN is retained
#: because `build()` and the deposit are unchanged and a future variable-width
#: render would want the same floor.
W_BOX = 0.42
W_MAX, W_MIN = 0.54, 0.09


def build() -> pd.DataFrame:
    rb = load("fig4.json")["robust"]
    total = sum(rb[k]["n"] for k, _ in STRATA if k in rb)
    rows = []
    for key, label in STRATA:
        if key not in rb:
            continue
        m = rb[key]["moved_mm"]
        rows.append({
            "stratum": key, "label": label, "n": rb[key]["n"],
            "share": rb[key]["n"] / total,
            "improved_frac": rb[key]["improved_frac"],
            "p5": m["p5"], "p25": m["p25"], "p50": m["p50"],
            "p75": m["p75"], "p95": m["p95"],
        })
    return pd.DataFrame(rows)


def main():
    use()
    r = load("fig4.json")["robust"]
    strata = ["clean", "mid", "outlier"]
    rows = []
    for st in strata:
        rows.append({"stratum": st, "n": r[st]["n"],
                     "all_views_px": r[st]["kept_view_err_before"]["mean"],
                     "worst_dropped_px": r[st]["kept_view_err_after"]["mean"],
                     "moved_mm_p50": r[st]["moved_mm"]["p50"],
                     "improved_frac": r[st]["improved_frac"]})
    df = pd.DataFrame(rows)
    n_tot = df.n.sum()
    pooled = {c: float((df[c] * df.n).sum() / n_tot)
              for c in ("all_views_px", "worst_dropped_px")}
    df = pd.concat([df, pd.DataFrame([{"stratum": "POOLED", "n": int(n_tot),
                                       **pooled}])], ignore_index=True)
    deposit(df, 4, "fig4c_worst_camera.csv")

    fig, ax = panel("third", "std", key=2)
    x = [0, 1]
    for _, row in df[df.stratum != "POOLED"].iterrows():
        ax.plot(x, [row.all_views_px, row.worst_dropped_px], color=GREY, lw=0.9,
                zorder=2)
        ax.plot(x, [row.all_views_px, row.worst_dropped_px], "o", color=GREY,
                ms=2.6, mec="white", mew=0.5, zorder=3)
    ax.plot(x, [pooled["all_views_px"], pooled["worst_dropped_px"]], color=TEAL,
            lw=2.2, zorder=4)
    ax.plot(x, [pooled["all_views_px"], pooled["worst_dropped_px"]], "o",
            color=TEAL, ms=6, mec="white", mew=1.0, zorder=5)

    text_legend(ax, [("pooled mean, 17.0M solves", TEAL),
                     ("disagreement strata (n 4.7M / 12.1M / 0.27M)", GREY)],
                "above", size=6.5)
    ax.set_xticks(x)
    ax.set_xticklabels(["all views\nin the solve", "worst view\ndropped"])
    ax.set_xlim(-0.4, 1.4)
    ax.set_ylabel("reprojection error in\nthe kept views (px)")
    ax.set_ylim(0, 7)
    save(fig, 4, "c", "worst_camera")


if __name__ == "__main__":
    main()
