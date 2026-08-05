#!/usr/bin/env python3
"""
Fig 2c -- where a two-anchor reprojection lands in the views nobody labelled.

The cost side of the protocol. Each keypoint is triangulated from TWO views and
reprojected into the views that were not used; this is the cumulative distribution
of that error.

TWO REFERENCES, AND THEY ANSWER DIFFERENT QUESTIONS. The solid curve scores against
the held-out view's OWN detection; the dashed one against the fully-informed
reference 3D. The gap between them (~1.65 px at the median) is the held-out view's
own detection noise -- error a labeller would have introduced by hand in that view
anyway. So the solid curve is conservative and the dashed one is
optimistic-by-shared-bias, and every headline number quotes the SOLID one:
median 4.32 px, 94.6% within the marked tau = 10 px, 99.68% within 20 px.

An earlier draft plotted only the flattering curve. Both are drawn here precisely so
that choice is visible rather than silent.

Source: figs/out/fig2.json `per_session[].{held_out,held_out_vs_observation}`.

    python3 figs/panels/fig2_03_reprojection_accuracy.py
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import (INK, SALMON, TEAL, deposit, panel, save,  # noqa: E402
                       text_legend, use)

TAU_MAIN = 10.0
QUANTILES = [("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75), ("p90", 90),
             ("p95", 95), ("p99", 99)]
TOLERANCES = [2.0, 5.0, 10.0, 20.0, 40.0]


def curve(ps, key) -> pd.DataFrame:
    """One CDF, assembled from the deposited percentiles AND accuracy-at-tolerance.

    The measurement pass summarised 38 M held-out views; only these order statistics
    survive into the JSON, so the curve is the union of the two families of points
    rather than an ECDF over raw samples.
    """
    agg = {}
    for q, _ in QUANTILES:
        agg[q] = median([s[key][q] for s in ps if s[key].get(q) is not None])
    for t in TOLERANCES:
        k = f"acc{int(t)}"
        vals = [s[key][k] for s in ps if s[key].get(k) is not None]
        if vals:
            agg[k] = median(vals)

    pts = [(0.0, 0.0)]
    pts += [(agg[q], v) for q, v in QUANTILES if q in agg]
    pts += [(t, agg[f"acc{int(t)}"] * 100) for t in TOLERANCES
            if f"acc{int(t)}" in agg]
    pts = sorted(set(pts))
    return pd.DataFrame(pts, columns=["error_px", "cumulative_pct"]), agg


def main():
    use()
    ps = load("fig2.json")["per_session"]
    obs, obs_agg = curve(ps, "held_out_vs_observation")
    ref, _ = curve(ps, "held_out")
    obs["reference"] = "held-out view's own detection"
    ref["reference"] = "fully-informed reference 3D"
    deposit(pd.concat([obs, ref]), 2, "fig2c_reprojection_accuracy.csv")

    # THREE key slots for TWO entries. `text_legend`'s "above" stack is spaced at
    # 0.052 of the figure height = 7.7 pt, which is less than the 8.9 pt an 8 pt
    # glyph box actually occupies: at key=2 the two lines' boxes overlapped each
    # other by ~1 pt and the first one's ascenders came within 0.8 pt of the page
    # edge. The extra slot buys the room to space them properly below.
    fig, ax = panel("third", "std", key=3)
    ax.plot(obs.error_px, obs.cumulative_pct, color=TEAL, lw=2.0, zorder=3)
    ax.plot(ref.error_px, ref.cumulative_pct, color=TEAL, lw=1.2,
            ls=(0, (2.5, 1.5)), zorder=3)
    ax.axvline(TAU_MAIN, color=SALMON, lw=0.8, ls=(0, (2.5, 1.5)), zorder=1)
    # LEFT of the rule: the right-hand side now carries the four-line number stack,
    # and the bottom entry of that stack sat on this label.
    ax.text(TAU_MAIN - 0.6, 8, f"τ = {TAU_MAIN:.0f} px", color=SALMON, fontsize=7,
            ha="right", va="bottom")

    ax.text(11.5, 52, f"median {obs_agg['p50']:.2f} px", color=TEAL, fontsize=7)
    # One decimal, matching the caption. `:.0f` printed 59.898% as "60%", so the
    # artwork and the caption disagreed on the same quantity -- and 60 reads as a
    # round number someone chose rather than a measurement.
    ax.text(11.5, 40, f"{obs_agg['acc5'] * 100:.1f}% ≤ 5 px", color=INK, fontsize=7)
    # The 10 px value is not optional: tau = 10 px is the ONE tolerance this panel
    # draws a rule for, so leaving it unquantified made the axis mark the tolerance
    # the artwork then refused to answer. Salmon, matching the rule it reads off.
    ax.text(11.5, 28, f"{obs_agg['acc10'] * 100:.1f}% ≤ {TAU_MAIN:.0f} px",
            color=SALMON, fontsize=7)
    ax.text(11.5, 16, f"{obs_agg['acc20'] * 100:.2f}% ≤ 20 px", color=INK,
            fontsize=7)

    # Both curves are TEAL and differ only by dash, so the key must say so. Colouring
    # the second entry grey implied a grey curve that does not exist.
    text_legend(ax, [("— vs the view's own detection", TEAL),
                     ("-- vs the reference 3D", TEAL)], "above",
                xy=(0.14, 0.972), dy=0.064, transform=fig.transFigure)
    ax.set_xlim(0, 25.4)
    ax.set_ylim(0, 100)
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_xlabel("error in an unlabelled view (px)")
    ax.set_ylabel("cumulative % of keypoints")
    save(fig, 2, "c", "reprojection_accuracy")


if __name__ == "__main__":
    main()
