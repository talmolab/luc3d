#!/usr/bin/env python3
"""
Fig 2c -- held-out reprojection error against the number of cameras in the solve.

REBUILT 2026-08-14 (review: "fig 2c should just be a box and whisker plot of the
reprojection error by number of cameras on the x axis and that will tell us the same
thing"). It does, and it answers a second question the CDF could not -- the
how-many-cameras question -- with the SAME measurement: every C-choose-k camera
subset, the solve reprojected into a camera it never saw, scored against that
camera's own detection. k = 2 IS the two-anchor protocol, so the old panel's headline
(median 4.32 px) is this panel's first box.

WHAT THE MARKS ARE. Box = p25-p50-p75 of held-out keypoint error (the deposit's
across-session medians of per-session percentiles; ~510M/340M/85M keypoint solves at
k = 2/3/4). No whiskers: p5/p95 were never computed upstream, and drawing whiskers
from a different quantity (per-session spread) on the same box would mix units --
the dots carry the spread instead. Dots = each session's own median, 50 per box.

The retired CDF renders under `--cdf` (slug `reprojection_cdf`); its two-reference
comparison (vs own detection / vs reference 3D) lives on in the legend.

Source: figs/out/fig4_by_views.json `heldout_px_across_sessions`, `per_session`.

    python3 figs/panels/fig2_03_reprojection_accuracy.py         # the box plot
    python3 figs/panels/fig2_03_reprojection_accuracy.py --cdf   # the retired CDF
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


def _curve(ps, key) -> pd.DataFrame:
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


def main_cdf():
    use()
    ps = load("fig2.json")["per_session"]
    obs, obs_agg = _curve(ps, "held_out_vs_observation")
    ref, _ = _curve(ps, "held_out")
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
    save(fig, 2, "c", "reprojection_cdf")


def main():
    use()
    j = load("fig4_by_views.json")
    agg = j["heldout_px_across_sessions"]
    per = j["per_session"]
    ks = sorted(agg, key=int)

    rows = []
    fig, ax = panel("third", "std")
    import numpy as np
    for i, k in enumerate(ks):
        g = agg[k]["dlt"]
        # The session dots first (zorder under the box): value-decorrelated
        # golden-ratio jitter, the same idiom as Fig 7c's cells.
        # `heldout_px_by_k`, NOT `by_k`. `by_k` is the 3D ERROR IN MM -- a different
        # quantity in a different unit that lands in the same numeric range, so the
        # dots sat below the k = 3, 4 box medians (50 sessions outside their own IQR,
        # which is arithmetically impossible for one quantity). Caught twice by
        # adversarial review: the first fix DIED IN A FAILED SHELL CALL and was then
        # claimed in a commit message without having run -- which is why this comment
        # states the check: after rendering, the k=4 dot cloud must straddle 3.34, not
        # sit at ~1.9.
        vals = np.array([s_["heldout_px_by_k"][k]["dlt"]["p50"] for s_ in per
                         if k in s_.get("heldout_px_by_k", {})])
        jit = ((np.arange(len(vals)) * 0.6180339887) % 1.0 - 0.5) * 0.30
        ax.plot(i + jit, vals, "o", color=TEAL, ms=2.2, alpha=0.40, mec="none",
                zorder=2)
        ax.bxp([{"med": g["p50"], "q1": g["p25"], "q3": g["p75"],
                 "whislo": g["p25"], "whishi": g["p75"], "fliers": []}],
               positions=[i], widths=0.42, showfliers=False, manage_ticks=False,
               # whisker ends coincide with the box edges: no whisker is drawn,
               # deliberately -- see the docstring.
               patch_artist=True,
               boxprops=dict(edgecolor=INK, lw=0.9, facecolor="none"),
               medianprops=dict(color=TEAL, lw=1.6),
               whiskerprops=dict(color=INK, lw=0), capprops=dict(color=INK, lw=0))
        # NO on-artwork value labels. Right of the box they landed on the next
        # box's dots, left of it on the previous box's (lint: ON DATA at 16, 8 and
        # -26 pt) -- at "third" width three columns leave no clear horizontal band.
        # The medians ARE the teal rules; their values (4.32/3.66/3.34) are in the
        # deposit and the legend, which is where the PI wants numbers anyway.
        rows.append({"cameras_in_solve": int(k), "p25": g["p25"], "p50": g["p50"],
                     "p75": g["p75"], "n_keypoint_solves": g["n_values"],
                     "n_sessions": g["n_sessions"]})
    deposit(pd.DataFrame(rows), 2, "fig2c_error_by_cameras.csv")

    ax.set_xticks(range(len(ks)))
    ax.set_xticklabels(ks)
    # "of 5": the axis stops at 4 because the metric is HELD-OUT -- one of the rig's
    # 5 cameras must stay out of the solve to judge it, so k = C - 1 is the maximum
    # the quantity exists for. Asked immediately by the first reader (2026-08-14), so
    # it belongs on the axis, not just in the legend.
    ax.set_xlabel("cameras in the solve, of 5\n(1 held out as judge)")
    ax.set_ylabel("held-out reprojection\nerror (px)")
    ax.set_xlim(-0.55, len(ks) - 0.45)
    ax.set_ylim(0, 8)
    save(fig, 2, "c", "reprojection_accuracy")


if __name__ == "__main__":
    main_cdf() if "--cdf" in sys.argv else main()
